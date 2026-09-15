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
