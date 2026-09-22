/**
 * The newsletter's period: a week or a calendar month, depending on the config's cadence.
 *
 * A period decides three things: its key (what the review is saved under), its first workday
 * (when the newsletter goes out, CLAUDE.md section 5), and the windows each source reads. The
 * windows are computed here once, as instants, so no fetcher does date arithmetic of its own and
 * all of it is in Halifax time whatever the server's clock is set to.
 */
import { localDateString, partsInZone, zonedToUtc } from "../clock.js";
import { cadenceOf, type Cadence, type Config } from "../config.js";
import { addDays, firstWorkdayOfWeek, holidayName, mondayOfWeek, type FirstWorkday } from "./first-workday.js";

const DAY_MS = 86_400_000;

export interface Period {
  cadence: Cadence;
  /** What the period's review is saved under: the Monday (2026-09-21) or the month (2026-10). */
  key: string;
  /** First local day of the period, YYYY-MM-DD. */
  start: string;
  /** First local day of the next period, YYYY-MM-DD (exclusive end). */
  end: string;
}

/** A span of time, from inclusive to exclusive. */
export interface Window {
  from: Date;
  to: Date;
}

export interface Windows {
  /** News, LinkedIn and Slack: items published in this span. */
  content: Window;
  /** Events starting in this span are the ones coming up. */
  upcoming: Window;
  /** Events held in this span, for a look back. Monthly only: a weekly newsletter has none. */
  past?: Window;
}

type PeriodConfig = Pick<Config, "timezone" | "holiday_overrides" | "cadence">;

/** YYYY-MM of an instant in a timezone. */
export function monthOf(now: Date, timeZone: string): string {
  const { year, month } = partsInZone(now, timeZone);
  return `${year}-${String(month).padStart(2, "0")}`;
}

/** The month after (n = 1) or before (n = -1) a YYYY-MM month. */
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const t = new Date(Date.UTC(y!, m! - 1 + n, 1));
  return t.toISOString().slice(0, 7);
}

export function periodOf(now: Date, config: PeriodConfig): Period {
  const cadence = cadenceOf(config);
  if (cadence === "weekly") {
    const monday = mondayOfWeek(now, config.timezone);
    return { cadence, key: monday, start: monday, end: addDays(monday, 7) };
  }
  const month = monthOf(now, config.timezone);
  return { cadence, key: month, start: `${month}-01`, end: `${addMonths(month, 1)}-01` };
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function weekdayOf(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return WEEKDAYS[new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay()]!;
}

/**
 * The first weekday of the month that is not a Nova Scotia holiday or a Volta closure. Weekends
 * are passed over silently; a holiday passed over is listed in `skipped` with its name, so the
 * reminder can say why the newsletter is not on the 1st.
 */
export function firstWorkdayOfMonth(month: string, config: Pick<Config, "holiday_overrides">): FirstWorkday {
  const skipped: string[] = [];
  const first = `${month}-01`;
  for (let date = first; date.startsWith(month); date = addDays(date, 1)) {
    const weekday = weekdayOf(date);
    if (weekday === "saturday" || weekday === "sunday") continue;
    const name = holidayName(date, config);
    if (!name) return { date, weekday, weekMonday: mondayOfDate(date), skipped };
    skipped.push(`${date} ${weekday}: ${name}`);
  }
  // A month with no workday at all cannot happen with real calendars; fall back to the 1st.
  return { date: first, weekday: weekdayOf(first), weekMonday: mondayOfDate(first), skipped };
}

function mondayOfDate(date: string): string {
  const dow = WEEKDAYS.indexOf(weekdayOf(date));
  return addDays(date, -(dow === 0 ? 6 : dow - 1));
}

/** When the period's newsletter goes out: the first workday of the week or of the month. */
export function firstWorkdayOfPeriod(now: Date, config: PeriodConfig): FirstWorkday {
  return cadenceOf(config) === "weekly"
    ? firstWorkdayOfWeek(now, config)
    : firstWorkdayOfMonth(monthOf(now, config.timezone), config);
}

/** The instant a local date and "HH:MM" time names, in a timezone. */
export function atLocal(date: string, hhmm: string, timeZone: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  return zonedToUtc(y!, m!, d!, h!, mi!, 0, timeZone);
}

/**
 * When the period's newsletter is due: the first workday at the reminder time, and the moment after
 * which it is too late to send it at all. Weekly gives up at the end of Friday, since a weekend
 * reminder would be replaced by Monday's; monthly allows a week of catch-up after the first workday,
 * since the next chance would otherwise be a month away.
 */
export function dueWindow(now: Date, config: PeriodConfig & Pick<Config, "reminder_time">): { period: Period; firstWorkday: FirstWorkday; dueAt: Date; giveUpAt: Date } {
  const period = periodOf(now, config);
  const firstWorkday = firstWorkdayOfPeriod(now, config);
  const dueAt = atLocal(firstWorkday.date, config.reminder_time, config.timezone);
  const giveUpAt = period.cadence === "weekly"
    ? atLocal(addDays(period.key, 5), "00:00", config.timezone)
    : atLocal(addDays(firstWorkday.date, 7), "00:00", config.timezone);
  return { period, firstWorkday, dueAt, giveUpAt };
}

/** Local midnight at the start of a YYYY-MM-DD day, as an instant. */
function startOfDay(date: string, timeZone: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  return zonedToUtc(y!, m!, d!, 0, 0, 0, timeZone);
}

/**
 * What each source reads for a run at `now`.
 *
 * Weekly: the last `content_window_days` of content and the next `events_window_days` of events,
 * exactly as before. Monthly, for a run in October: content from 1 September to now, events
 * from now to the end of October, and events held from 1 September until now as the look back.
 * Upcoming and past meet at `now`, so no event falls between them or is counted twice.
 */
export function windowsFor(now: Date, config: PeriodConfig & Pick<Config, "content_window_days" | "events_window_days">): Windows {
  if (cadenceOf(config) === "weekly") {
    return {
      content: { from: new Date(now.getTime() - config.content_window_days * DAY_MS), to: now },
      upcoming: { from: now, to: new Date(now.getTime() + config.events_window_days * DAY_MS) },
    };
  }
  const month = monthOf(now, config.timezone);
  const previousStart = startOfDay(`${addMonths(month, -1)}-01`, config.timezone);
  const nextStart = startOfDay(`${addMonths(month, 1)}-01`, config.timezone);
  return {
    content: { from: previousStart, to: now },
    upcoming: { from: now, to: nextStart },
    past: { from: previousStart, to: now },
  };
}

/**
 * The windows a fetch should read: the run's, when it passed them, else worked out from the clock
 * and config, so a fetcher called on its own (check:sources, a test) reads the same spans.
 */
export function windowsOf(ctx: { windows?: Windows; clock: { now(): Date }; config: Parameters<typeof windowsFor>[1] }): Windows {
  return ctx.windows ?? windowsFor(ctx.clock.now(), ctx.config);
}

/** True when an instant falls in a window. */
export function inWindow(t: Date | number, w: Window): boolean {
  const ms = typeof t === "number" ? t : t.getTime();
  return ms >= w.from.getTime() && ms < w.to.getTime();
}

/** A window as local dates, for logs and the pre-flight report: "2026-09-01 to 2026-10-01 08:30". */
export function describeWindow(w: Window, timeZone: string): string {
  const at = (d: Date) => {
    const p = partsInZone(d, timeZone);
    const time = p.hour === 0 && p.minute === 0 ? "" : ` ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
    return `${localDateString(d, timeZone)}${time}`;
  };
  return `${at(w.from)} to ${at(w.to)}`;
}
