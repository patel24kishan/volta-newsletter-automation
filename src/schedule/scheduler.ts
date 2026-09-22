/**
 * Sends the weekly reminder without anyone starting anything. A long-running service checks every
 * few minutes; this decides what, if anything, is due, and does it exactly once per week.
 *
 * `reminderDue` (first-workday.ts) answers "is this the reminder moment?" and is true only on the
 * first workday itself. A service needs more: if the host was down all Monday, that answer is no
 * on Tuesday and the week would be skipped without anyone knowing. So here a missed reminder is
 * sent late, with a note saying so, until the end of Friday, and only then given up with an alert.
 */
import type { Alerter } from "../alerts.js";
import { zonedToUtc, type Clock } from "../clock.js";
import type { Config } from "../config.js";
import type { Storage } from "../storage.js";
import type { ReminderInput } from "../surface/blocks.js";
import { sendReminder, type SlackClient, type SurfaceState } from "../surface/handlers.js";
import { parseSession } from "../surface/session.js";
import { addDays, firstWorkdayOfWeek, mondayOfWeek, type FirstWorkday } from "./first-workday.js";

export type ReminderState = "not-yet" | "due" | "due-late" | "missed" | "closed" | "sent";

export interface Decision {
  /** The Monday of the week `now` falls in, which is how a week is named everywhere. */
  week: string;
  reminder: ReminderState;
  firstWorkday: FirstWorkday;
  dueAt: Date;
}

/** Past this, a reminder still goes out but says it is late. */
export const LATE_AFTER_MS = 60 * 60 * 1000;
/** A send claim older than this was abandoned by a process that died, and can be taken over. */
export const CLAIM_TTL_MS = 10 * 60 * 1000;

type ScheduleConfig = Pick<Config, "timezone" | "holiday_overrides" | "reminder_time">;

/** What is due at `now`. Pure: the same inputs always give the same answer, whatever the server's timezone. */
export function whatIsDue(now: Date, config: ScheduleConfig, state: { reminderSent: boolean }): Decision {
  const week = mondayOfWeek(now, config.timezone);
  const firstWorkday = firstWorkdayOfWeek(now, config);
  const dueAt = atLocal(firstWorkday.date, config.reminder_time, config.timezone);
  const base = { week, firstWorkday, dueAt };
  if (state.reminderSent) return { ...base, reminder: "sent" };
  // Every weekday closed (the year-end week): no reminder for a newsletter nobody will send.
  if (firstWorkday.skipped.length >= 5) return { ...base, reminder: "closed" };
  if (now < dueAt) return { ...base, reminder: "not-yet" };
  // Saturday 00:00 local ends the chance: a weekend reminder would be replaced by Monday's.
  if (now >= atLocal(addDays(week, 5), "00:00", config.timezone)) return { ...base, reminder: "missed" };
  return { ...base, reminder: now.getTime() - dueAt.getTime() > LATE_AFTER_MS ? "due-late" : "due" };
}

function atLocal(date: string, hhmm: string, timeZone: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  return zonedToUtc(y!, m!, d!, h!, mi!, 0, timeZone);
}

export interface SchedulerDeps {
  config: ScheduleConfig;
  clock: Clock;
  storage: Pick<Storage, "loadSession" | "claimMark" | "releaseMark" | "completeMark" | "getMark" | "setMarkPayload">;
  st: SurfaceState;
  client: SlackClient;
  userId: string;
  alerter: Alerter;
  /** The same one-at-a-time queue the Slack clicks use, so a new week never lands mid-click. */
  queue: (work: () => Promise<void>) => Promise<void>;
  /** Runs the week and returns what the reminder shows. Injected so tests need no network. */
  prepareWeek: () => Promise<ReminderInput>;
  isLive: () => boolean;
  log?: (msg: string) => void;
  /** After a new week's review is live, e.g. to refresh the Mailchimp audience count. */
  onNewReview?: () => Promise<void>;
  /** Before each check, e.g. to retry an email platform that was down at startup. */
  everyTick?: () => Promise<void>;
}

export class WeeklyScheduler {
  private running: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  /** Set while sends keep failing, so the streak raises one alert rather than one per check. */
  private failing = false;
  /** The same, for a check that fails before it reaches a send. */
  private checkFailing = false;
  private readonly log: (msg: string) => void;

  constructor(private readonly d: SchedulerDeps) {
    this.log = d.log ?? ((msg) => console.log(`${new Date().toISOString()} scheduler: ${msg}`));
  }

  start(intervalMs: number): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), intervalMs);
  }

  /** No new check starts after this; resolves once any check already running has finished. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }

  /**
   * One check. A check that arrives while the previous one is still running is skipped. It never
   * rejects: the timer fires it without waiting, and in Node an unhandled rejection ends the
   * process, so one bad check would otherwise take the whole service down.
   */
  async tick(): Promise<void> {
    if (this.stopped || this.running) return;
    this.running = this.check()
      .then(() => { this.checkFailing = false; })
      .catch((e: unknown) => {
        if (!this.checkFailing) this.d.alerter.alert("error", "schedule", `the scheduled check failed: ${(e as Error).message}`, "it runs again in a few minutes; check the service logs if this repeats");
        this.checkFailing = true;
      })
      .finally(() => { this.running = undefined; });
    await this.running;
  }

  private async check(): Promise<void> {
    try {
      await this.d.everyTick?.();
    } catch { /* its own business to alert; a failed retry must not stop the reminder */ }
    const now = this.d.clock.now();
    const week = mondayOfWeek(now, this.d.config.timezone);
    const raw = this.d.storage.loadSession(week);
    const readable = raw !== undefined && !("error" in parseSession(raw));
    const decision = whatIsDue(now, this.d.config, { reminderSent: readable });

    switch (decision.reminder) {
      case "not-yet":
      case "sent":
        return;
      case "closed":
        await this.once("reminder-closed", week, async () => {
          this.d.alerter.alert("info", "schedule", `no reminder for the week of ${week}: every weekday is a holiday or closure`, "no action");
        });
        return;
      case "missed":
        await this.once("reminder-missed", week, async () => {
          this.d.alerter.alert("error", "schedule", `this week's reminder was never sent: it was due ${decision.firstWorkday.weekday} ${decision.firstWorkday.date} at ${this.d.config.reminder_time} and the service could not send it before the end of Friday`, "check the service logs and send this week's newsletter by hand if it is still wanted");
        });
        return;
      case "due":
      case "due-late":
        await this.sendWeek(decision, raw !== undefined && !readable);
    }
  }

  private async sendWeek(decision: Decision, replacing: boolean): Promise<void> {
    const { week } = decision;
    // Dry-run rehearses the week once, and never sends (CLAUDE.md section 4). The mark keeps later
    // checks and restarts from fetching every source again.
    if (!this.d.isLive()) {
      await this.once("reminder-rehearsal", week, async () => {
        await this.d.prepareWeek();
        this.log(`dry-run: the reminder for the week of ${week} would be sent now; set ALLOW_LIVE=1 to send it`);
      });
      return;
    }

    const nowIso = this.d.clock.now().toISOString();
    // Of two processes checking at once, one sends. The other finds the claim taken and waits.
    if (!this.d.storage.claimMark("reminder-send", week, nowIso, CLAIM_TTL_MS)) return;
    try {
      const input = await this.preparedInput(week);
      const notes = [...input.sourceNotes];
      if (decision.reminder === "due-late") notes.unshift(`This reminder is late: it was due ${cap(decision.firstWorkday.weekday)} ${decision.firstWorkday.date} at ${this.d.config.reminder_time}, and the service was not running then.`);
      if (replacing) notes.unshift("This list replaces the earlier one this week, which could not be restored.");
      const toSend: ReminderInput = { ...input, sourceNotes: notes };

      let sent = false;
      await this.d.queue(async () => {
        // Sent in the meantime, by another process or a demo run: nothing to do.
        const again = this.d.storage.loadSession(week);
        if (again !== undefined && !("error" in parseSession(again))) return;
        sent = await this.startNewReview(week, toSend);
      });
      if (!sent) return;

      if (this.failing) this.log("the reminder was sent after earlier failures");
      this.failing = false;
      if (decision.reminder === "due-late") this.d.alerter.alert("warning", "schedule", `this week's reminder went out late, at ${nowIso}`, "check why the service was not running at the reminder time");
      if (replacing) this.d.alerter.alert("warning", "session", "this week's saved review could not be read, so a replacement list was sent", "check the service logs; the earlier list's buttons no longer act");
      this.log(`reminder sent for the week of ${week}`);
      try {
        await this.d.onNewReview?.();
      } catch { /* the review is live; a stale audience count is not worth failing over */ }
    } catch (e) {
      // Give the claim back so the next check retries, with the week already prepared.
      this.d.storage.releaseMark("reminder-send", week);
      if (!this.failing) this.d.alerter.alert("error", "schedule", `could not send this week's reminder: ${(e as Error).message}`, "it will be retried every few minutes; check Slack and the service logs");
      this.failing = true;
    }
  }

  /**
   * Send the reminder for a new week on a scratch copy, and only once it has gone out, make that
   * the live review. Swapping first would leave last week's reminder in place under this week's
   * name if the send then failed, and the next save would make the week look already sent.
   */
  private async startNewReview(week: string, input: ReminderInput): Promise<boolean> {
    const { st, client, userId } = this.d;
    const scratch: SurfaceState = { ...st, week, candidates: input.candidates, drafts: new Map(), selections: new Map() };
    delete scratch.reminder;
    delete scratch.postedDraft;
    await sendReminder(client, userId, input, scratch);
    // One synchronous step: nothing can observe a half-switched week.
    st.week = week;
    st.candidates = scratch.candidates;
    st.drafts = scratch.drafts;
    st.selections = scratch.selections;
    if (scratch.reminder) st.reminder = scratch.reminder;
    delete st.postedDraft;
    return true;
  }

  /** The week as prepared earlier, or prepared now and kept, so a retry need not fetch again. */
  private async preparedInput(week: string): Promise<ReminderInput> {
    const kept = this.d.storage.getMark("reminder-input", week)?.payload;
    if (kept) {
      try {
        return JSON.parse(kept) as ReminderInput;
      } catch { /* prepare again below */ }
    }
    const input = await this.d.prepareWeek();
    this.d.storage.setMarkPayload("reminder-input", week, JSON.stringify(input));
    return input;
  }

  /** Do `work` once for the week. Marked done only if it succeeds, so a failure is tried again. */
  private async once(task: string, week: string, work: () => Promise<void>): Promise<void> {
    if (this.d.storage.getMark(task, week)?.done_at) return;
    await work();
    this.d.storage.completeMark(task, week, this.d.clock.now().toISOString());
  }
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
