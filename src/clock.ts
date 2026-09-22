/**
 * Every stage reads "now" through this so a demo can be run as if it were any date and time.
 * Precedence: --now=<ISO> on the command line, then DEMO_NOW env, then the real clock.
 * Requirement (user, 2026-09-15): the demo must be testable today with a chosen date and time.
 */
export interface Clock {
  now(): Date;
  /** True when the time is overridden, so logs and messages can say so. */
  overridden: boolean;
  /** The override as given, for display. */
  label: string;
}

export class ClockError extends Error {}

export function resolveClock(argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Clock {
  const fromArg = argv.find((a) => a.startsWith("--now="))?.slice("--now=".length);
  const raw = fromArg ?? env.DEMO_NOW;
  if (raw === undefined || raw.trim() === "") {
    return { now: () => new Date(), overridden: false, label: "real clock" };
  }
  const t = Date.parse(raw);
  if (Number.isNaN(t)) {
    throw new ClockError(`--now / DEMO_NOW is not a parseable date-time: "${raw}". Use ISO 8601, e.g. 2026-10-12T08:30:00-03:00`);
  }
  const fixed = new Date(t);
  return { now: () => new Date(fixed.getTime()), overridden: true, label: `overridden to ${raw}` };
}

/**
 * A clock that starts at a chosen instant and then keeps time. The frozen override above suits
 * one-shot commands; a long-running service driven by it would never see time pass, so it could
 * never reach the reminder. This one lets a rehearsal start at 08:28 and be watched sending at 08:30.
 */
export function advancingClock(start: Date, realNow: () => number = Date.now): Clock {
  const offset = start.getTime() - realNow();
  return { now: () => new Date(realNow() + offset), overridden: true, label: `starting at ${start.toISOString()} and moving forward` };
}

/** Wall-clock parts of an instant in a named timezone (Halifax), without a library. */
export function partsInZone(d: Date, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number; weekday: string } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, weekday: "long",
  });
  const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
  return {
    year: Number(p.year), month: Number(p.month), day: Number(p.day),
    hour: Number(p.hour) % 24, minute: Number(p.minute), weekday: String(p.weekday).toLowerCase(),
  };
}

/** YYYY-MM-DD of an instant in a timezone. */
export function localDateString(d: Date, timeZone: string): string {
  const { year, month, day } = partsInZone(d, timeZone);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * The inverse of partsInZone: wall-clock parts in a zone to a UTC instant, using Intl with a
 * two-pass offset correction so a date on a daylight-saving boundary lands on the right hour.
 */
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, timeZone: string): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const offset1 = offsetMs(new Date(guess), timeZone);
  const candidate = guess - offset1;
  const offset2 = offsetMs(new Date(candidate), timeZone);
  return new Date(guess - offset2);
}

export function isKnownTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function offsetMs(d: Date, timeZone: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return asUtc - d.getTime();
}
