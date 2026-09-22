/**
 * The always-on service's weekly reminder. `whatIsDue` is tested with fixed instants; the checks
 * run against a real SQLite file, a recording Slack client, a fake weekly run and a clock the test
 * moves, so a restart is a second scheduler opening the same file.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryAlerter } from "../src/alerts.js";
import { advancingClock, type Clock } from "../src/clock.js";
import type { PublishedCampaign, Publisher } from "../src/publish/types.js";
import { rankItems } from "../src/pipeline/rank.js";
import { whatIsDue, WeeklyScheduler } from "../src/schedule/scheduler.js";
import { SqliteStorage } from "../src/storage.js";
import { isFromAnotherWeek, reminderBlocks, weekOfControl, type ReminderInput } from "../src/surface/blocks.js";
import { approveDraft, rememberSelection, sendCampaign, sendReminder, type SlackClient, type SurfaceState } from "../src/surface/handlers.js";
import { serialQueue } from "../src/surface/serial.js";
import { pickUpReview, serveEnvironmentProblem } from "../src/cli/start-surface.js";
import { sampleItem } from "./helpers.js";

const TZ = "America/Halifax";
const CONFIG = { timezone: TZ, reminder_time: "08:30", holiday_overrides: ["2026-10-12", "2026-12-28", "2026-12-29", "2026-12-30", "2026-12-31"] };
const WEEK = "2026-09-21";
const LAST_WEEK = "2026-09-14";
const at = (iso: string) => new Date(iso);
const due = (iso: string, sent = false) => whatIsDue(at(iso), CONFIG, { reminderSent: sent }).reminder;

describe("whatIsDue", () => {
  it("is due from 08:30 Halifax on the first workday, and late an hour after", () => {
    expect(due("2026-09-21T11:29:00Z")).toBe("not-yet"); // Monday 08:29 ADT
    expect(due("2026-09-21T11:30:00Z")).toBe("due"); //     08:30
    expect(due("2026-09-21T12:30:00Z")).toBe("due"); //     09:30, exactly an hour
    expect(due("2026-09-21T12:31:00Z")).toBe("due-late"); // 09:31
  });

  it("catches up on a later day of the same week, and stops once sent", () => {
    expect(due("2026-09-22T15:00:00Z")).toBe("due-late"); // Tuesday of a normal week
    expect(due("2026-09-22T15:00:00Z", true)).toBe("sent");
  });

  it("moves to Tuesday when Monday is a closure (Thanksgiving)", () => {
    expect(due("2026-10-12T15:00:00Z")).toBe("not-yet");
    expect(due("2026-10-13T11:30:00Z")).toBe("due");
  });

  it("treats Sunday night in Halifax as the week before, although it is already Monday in UTC", () => {
    const d = whatIsDue(at("2026-09-28T01:00:00Z"), CONFIG, { reminderSent: false }); // Sun 22:00 ADT
    expect(d.week).toBe(WEEK);
    expect(d.reminder).toBe("missed");
  });

  it("gives up at the end of Friday rather than sending a weekend reminder", () => {
    expect(due("2026-09-26T02:59:00Z")).toBe("due-late"); // Friday 23:59 ADT
    expect(due("2026-09-26T03:00:00Z")).toBe("missed"); //   Saturday 00:00
  });

  it("sends nothing in a week with no workday at all", () => {
    expect(due("2026-12-28T15:00:00Z")).toBe("closed"); // 28–31 closed, 1 January a holiday
  });

  it("stays at 08:30 local across both daylight-saving changes", () => {
    expect(due("2026-03-09T11:30:00Z")).toBe("due"); //     08:30 ADT, the day after clocks go forward
    expect(due("2026-11-02T11:30:00Z")).toBe("not-yet"); // 07:30 AST, the day after clocks go back
    expect(due("2026-11-02T12:30:00Z")).toBe("due"); //     08:30 AST
  });

  it("reads the time in Halifax, not the server's timezone", () => {
    expect(due("2026-09-21T08:31:00Z")).toBe("not-yet"); // 05:31 in Halifax
  });
});

// --- checks ---------------------------------------------------------------------------------

const items = [
  sampleItem({ type: "event", source: "volta-calendar", link: "https://e.test/yoga", title: "Yoga", date: "2026-09-24T15:00:00Z", raw_excerpt: "Yoga session." }),
  sampleItem({ link: "https://news.test/a", title: "Volta launches a program" }),
];
const candidates = rankItems(items, at("2026-09-21T12:00:00Z"));
const inputFor = (week: string, date = week): ReminderInput => ({
  candidates, preselectedIds: [items[0]!.id], firstWorkday: { date, weekday: "monday", weekMonday: week, skipped: [] },
  timeZone: TZ, clockLabel: "test", sourceNotes: [],
});
const REMINDER = "This week's newsletter is ready";

class TestClock implements Clock {
  overridden = true;
  label = "test";
  constructor(public current: Date) {}
  now() { return new Date(this.current.getTime()); }
}

class FakeClient implements SlackClient {
  posts: Array<{ channel: string; text: string; blocks?: unknown[] }> = [];
  /** How many of the next posts fail, as a Slack outage would. */
  failPosts = 0;
  /** While set, posts wait for it, as a slow Slack would. */
  hold?: Promise<void>;
  async postMessage(args: { channel: string; text: string; blocks?: unknown[] }) {
    if (this.hold) await this.hold;
    if (this.failPosts > 0) { this.failPosts--; throw new Error("Slack is unavailable"); }
    this.posts.push(args);
    return { ts: `${this.posts.length}.0`, channel: args.channel };
  }
  async openDm(userId: string) { return `D_${userId}`; }
  reminders() { return this.posts.filter((p) => p.text.startsWith(REMINDER)); }
}

class FakeMail implements Publisher {
  readonly platform = "Mailchimp";
  sent: string[] = [];
  async verify() { return { audienceName: "Test", memberCount: 2 }; }
  async publishDraft(): Promise<PublishedCampaign> { return { id: "camp_new", editUrl: "https://mc.test/e", platform: this.platform }; }
  async send(id: string) { this.sent.push(id); }
}

let dir: string;
let path: string;
const opened: SqliteStorage[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "volta-sched-"));
  path = join(dir, "newsletter.sqlite");
});
afterEach(() => {
  for (const s of opened.splice(0)) { try { s.close(); } catch { /* already closed */ } }
  rmSync(dir, { recursive: true, force: true });
});

function open(): SqliteStorage {
  const s = new SqliteStorage(path);
  opened.push(s);
  return s;
}

interface Harness {
  scheduler: WeeklyScheduler;
  client: FakeClient;
  alerter: MemoryAlerter;
  st: SurfaceState;
  storage: SqliteStorage;
  prepared: { count: number };
}

function harness(o: { clock: TestClock; storage?: SqliteStorage; live?: boolean; st?: SurfaceState; gate?: Promise<void> }): Harness {
  const storage = o.storage ?? open();
  const st: SurfaceState = o.st ?? {
    candidates: [], timeZone: TZ, outDir: dir, drafts: new Map(), selections: new Map(),
    env: { ALLOW_LIVE: o.live === false ? "0" : "1" }, campaigns: new Set(), session: storage, week: LAST_WEEK,
  };
  const client = new FakeClient();
  const alerter = new MemoryAlerter();
  const prepared = { count: 0 };
  const scheduler = new WeeklyScheduler({
    config: CONFIG, clock: o.clock, storage, st, client, userId: "U", alerter, queue: serialQueue(),
    prepareWeek: async () => { prepared.count++; if (o.gate) await o.gate; return inputFor(WEEK); },
    isLive: () => o.live !== false,
    log: () => undefined,
  });
  return { scheduler, client, alerter, st, storage, prepared };
}

const MONDAY_0835 = "2026-09-21T11:35:00Z";

describe("a scheduled check", () => {
  it("does nothing before the reminder time", async () => {
    const h = harness({ clock: new TestClock(at("2026-09-21T11:00:00Z")) });
    await h.scheduler.tick();
    expect(h.prepared.count).toBe(0);
    expect(h.client.posts).toEqual([]);
  });

  it("sends the reminder once when due, and saves it under the new week", async () => {
    const h = harness({ clock: new TestClock(at(MONDAY_0835)) });
    await h.scheduler.tick();
    await h.scheduler.tick();
    expect(h.prepared.count).toBe(1);
    expect(h.client.reminders()).toHaveLength(1);
    expect(h.st.week).toBe(WEEK);
    expect(h.storage.loadSession(WEEK)).toEqual(expect.any(String));
  });

  it("does not send again after a restart", async () => {
    const clock = new TestClock(at(MONDAY_0835));
    const first = harness({ clock });
    await first.scheduler.tick();
    first.storage.close();
    const second = harness({ clock, storage: open() });
    await second.scheduler.tick();
    expect(second.client.reminders()).toHaveLength(0);
    expect(second.prepared.count).toBe(0);
  });

  it("retries a failed send without fetching the week again, and alerts once for the streak", async () => {
    const h = harness({ clock: new TestClock(at(MONDAY_0835)) });
    h.client.failPosts = 2;
    await h.scheduler.tick();
    await h.scheduler.tick();
    expect(h.client.reminders()).toHaveLength(0);
    await h.scheduler.tick();
    expect(h.client.reminders()).toHaveLength(1);
    expect(h.prepared.count).toBe(1); // the week was prepared once, and reused
    expect(h.alerter.sent.filter((a) => a.level === "error" && a.source === "schedule")).toHaveLength(1);
  });

  it("reuses the prepared week after a restart that follows a failed send", async () => {
    const clock = new TestClock(at(MONDAY_0835));
    const first = harness({ clock });
    first.client.failPosts = 1;
    await first.scheduler.tick();
    first.storage.close();
    const second = harness({ clock, storage: open() });
    await second.scheduler.tick();
    expect(second.client.reminders()).toHaveLength(1);
    expect(second.prepared.count).toBe(0); // no second weekly run, so no second LinkedIn request
  });

  it("in dry-run rehearses the week once and never sends, across checks and a restart", async () => {
    const clock = new TestClock(at(MONDAY_0835));
    const first = harness({ clock, live: false });
    await first.scheduler.tick();
    await first.scheduler.tick();
    first.storage.close();
    const second = harness({ clock, live: false, storage: open() });
    await second.scheduler.tick();
    expect(first.prepared.count + second.prepared.count).toBe(1);
    expect([...first.client.posts, ...second.client.posts]).toEqual([]);
  });

  it("switches to the new week without breaking last week's campaign or its saved review", async () => {
    const storage = open();
    const mail = new FakeMail();
    const st: SurfaceState = {
      candidates: [], timeZone: TZ, outDir: dir, drafts: new Map(), selections: new Map(), env: { ALLOW_LIVE: "1" },
      campaigns: new Set(["camp_old"]), session: storage, week: LAST_WEEK, publisher: mail, audience: { audienceName: "Test", memberCount: 2 },
    };
    await sendReminder(new FakeClient(), "U", inputFor(LAST_WEEK), st);
    st.drafts.set("old-key", { key: "old-key", draft: { id: "events-first", name: "Events first", subject: "Old", markdown: "", html: "", item_ids: [], verification: { ok: true, violations: [], checked: { links: 0, entities: 0, dates: 0, times: 0 } } } as never, items: [] });
    storage.recordCampaign("camp_old", "old-key");
    const lastWeekRow = storage.loadSession(LAST_WEEK);

    const h = harness({ clock: new TestClock(at(MONDAY_0835)), storage, st });
    await h.scheduler.tick();

    expect(st.week).toBe(WEEK);
    const c = new FakeClient();
    expect(await approveDraft(c, "D_U", "old-key", st)).toBeUndefined(); // last week's draft is gone
    expect(await sendCampaign(c, "D_U", "camp_old", st)).toBe(true); //    its campaign is not
    expect(mail.sent).toEqual(["camp_old"]);
    expect(storage.loadSession(LAST_WEEK)).toBe(lastWeekRow);
  });

  it("regression: a tick on last week's list after a failed send does not make this week look sent", async () => {
    const storage = open();
    const st: SurfaceState = { candidates: [], timeZone: TZ, outDir: dir, drafts: new Map(), selections: new Map(), env: { ALLOW_LIVE: "1" }, campaigns: new Set(), session: storage, week: LAST_WEEK };
    await sendReminder(new FakeClient(), "U", inputFor(LAST_WEEK), st);
    const h = harness({ clock: new TestClock(at(MONDAY_0835)), storage, st });
    h.client.failPosts = 1;
    await h.scheduler.tick();

    rememberSelection(st, "D_U", [items[1]!.id]); // Bader ticks last week's list meanwhile

    expect(storage.loadSession(WEEK)).toBeUndefined();
    await h.scheduler.tick();
    expect(h.client.reminders()).toHaveLength(1);
  });

  it("sends one reminder when two copies of the service check at the same moment", async () => {
    const clock = new TestClock(at(MONDAY_0835));
    const a = harness({ clock });
    const b = harness({ clock, storage: open() });
    // Slack is slow, so both copies are mid-send before either has saved the review: the storage
    // recheck cannot tell them apart, and only the send claim keeps the second from posting.
    let release!: () => void;
    const slack = new Promise<void>((r) => { release = r; });
    a.client.hold = slack;
    b.client.hold = slack;
    const both = Promise.all([a.scheduler.tick(), b.scheduler.tick()]);
    await new Promise((r) => setTimeout(r, 50));
    release();
    await both;
    expect(a.client.reminders().length + b.client.reminders().length).toBe(1);
  });

  it("skips a check that arrives while the previous one is still running", async () => {
    // In dry-run, since there the send claim does not apply: the only thing stopping a second
    // weekly run is that the check skips itself while the first is still going.
    let release!: () => void;
    const h = harness({ clock: new TestClock(at(MONDAY_0835)), live: false, gate: new Promise<void>((r) => { release = r; }) });
    const first = h.scheduler.tick();
    await h.scheduler.tick(); // returns at once
    release();
    await first;
    expect(h.prepared.count).toBe(1);
  });

  it("replaces a saved review that cannot be read, once, and says so", async () => {
    const storage = open();
    storage.saveSession(WEEK, "{not json");
    const h = harness({ clock: new TestClock(at(MONDAY_0835)), storage });
    await h.scheduler.tick();
    await h.scheduler.tick();
    expect(h.client.reminders()).toHaveLength(1);
    expect(JSON.stringify(h.client.reminders()[0]!.blocks)).toContain("replaces the earlier one");
    expect(h.alerter.sent.filter((a) => a.source === "session")).toHaveLength(1);
  });

  it("alerts once and sends nothing in a closed week, and once when a week was missed", async () => {
    const closed = harness({ clock: new TestClock(at("2026-12-28T15:00:00Z")) });
    await closed.scheduler.tick();
    await closed.scheduler.tick();
    expect(closed.client.posts).toEqual([]);
    expect(closed.alerter.sent.map((a) => a.level)).toEqual(["info"]);

    const missed = harness({ clock: new TestClock(at("2026-09-26T15:00:00Z")) }); // Saturday
    await missed.scheduler.tick();
    await missed.scheduler.tick();
    expect(missed.client.posts).toEqual([]);
    expect(missed.alerter.sent.map((a) => a.level)).toEqual(["error"]);
  });

  it("says in the reminder, and in an alert, when it is late", async () => {
    const h = harness({ clock: new TestClock(at("2026-09-21T14:00:00Z")) }); // Monday 11:00
    await h.scheduler.tick();
    expect(JSON.stringify(h.client.reminders()[0]!.blocks)).toContain("This reminder is late");
    expect(h.alerter.sent.some((a) => a.level === "warning" && /late/.test(a.message))).toBe(true);
  });

  it("starts no check after it has been stopped", async () => {
    const h = harness({ clock: new TestClock(at(MONDAY_0835)) });
    await h.scheduler.stop();
    await h.scheduler.tick();
    expect(h.prepared.count).toBe(0);
  });
});

describe("controls that belong to a week", () => {
  it("tag Generate, the checkboxes and Add an event with their week", () => {
    const blocks = reminderBlocks(inputFor(WEEK)) as Array<{ block_id?: string; elements?: Array<{ action_id: string; value?: string }> }>;
    const buttons = blocks.flatMap((b) => b.elements ?? []);
    expect(buttons.find((e) => e.action_id === "newsletter_generate")!.value).toBe(WEEK);
    expect(buttons.find((e) => e.action_id === "newsletter_add_event")!.value).toBe(WEEK);
    expect(blocks.filter((b) => b.block_id?.startsWith("select_")).every((b) => weekOfControl(b.block_id) === WEEK)).toBe(true);
  });

  it("are recognised as another week's, while a list from before this change still counts as current", () => {
    expect(isFromAnotherWeek(WEEK, LAST_WEEK)).toBe(true);
    expect(isFromAnotherWeek(WEEK, `select_${LAST_WEEK}_0`)).toBe(true);
    expect(isFromAnotherWeek(WEEK, WEEK)).toBe(false);
    expect(isFromAnotherWeek(WEEK, "generate")).toBe(false);
    expect(isFromAnotherWeek(WEEK, "select_0")).toBe(false);
    expect(isFromAnotherWeek(undefined, LAST_WEEK)).toBe(false);
  });
});

describe("starting the service", () => {
  it("refuses a live start that would freeze or forget, and allows a rehearsal", () => {
    expect(serveEnvironmentProblem({ ALLOW_LIVE: "1", DATABASE_PATH: "/data/db" }, { overridden: true })).toMatch(/clock overridden/);
    expect(serveEnvironmentProblem({ ALLOW_LIVE: "1" }, { overridden: false })).toMatch(/DATABASE_PATH/);
    expect(serveEnvironmentProblem({ ALLOW_LIVE: "1", DATABASE_PATH: "/data/db" }, { overridden: false })).toBeUndefined();
    expect(serveEnvironmentProblem({}, { overridden: true })).toBeUndefined();
  });

  it("lets a rehearsal clock move forward from the time it was given", () => {
    let real = 1_000_000;
    const clock = advancingClock(at("2026-09-21T11:28:00Z"), () => real);
    expect(clock.now().toISOString()).toBe("2026-09-21T11:28:00.000Z");
    real += 2 * 60_000;
    expect(clock.now().toISOString()).toBe("2026-09-21T11:30:00.000Z");
  });

  it("picks up last week's review while this week has none, so a restart changes nothing", async () => {
    const storage = open();
    const st: SurfaceState = { candidates: [], timeZone: TZ, outDir: dir, drafts: new Map(), selections: new Map(), env: { ALLOW_LIVE: "1" }, campaigns: new Set(), session: storage, week: LAST_WEEK };
    await sendReminder(new FakeClient(), "U", inputFor(LAST_WEEK), st);

    const service = pickUpReview(storage, WEEK, { fallBackAWeek: true });
    expect(service.week).toBe(LAST_WEEK);
    expect(service.snapshot).toBeDefined();
    const demo = pickUpReview(storage, WEEK, { fallBackAWeek: false });
    expect(demo).toEqual({ week: WEEK });
  });
});
