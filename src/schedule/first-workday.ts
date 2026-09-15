/**
 * First-workday rule (CLAUDE.md section 5). The reminder and the send day key off the first
 * non-holiday weekday of the week, never a hardcoded Monday.
 *
 * Holidays = Nova Scotia public holidays from date-holidays (CA-NS) plus the config's
 * holiday_overrides for Volta closure days. Note: Thanksgiving is NOT a statutory holiday in
 * Nova Scotia, so it must be listed as an override if Volta closes for it (the demo config does).
 */
import Holidays from "date-holidays";
import type { Config } from "../config.js";
import { localDateString, partsInZone } from "../clock.js";

export interface FirstWorkday {
  /** YYYY-MM-DD in the configured timezone. */
  date: string;
  weekday: string;
  /** Monday of that week, YYYY-MM-DD. */
  weekMonday: string;
  /** Days skipped and why, e.g. ["2026-10-12 monday: Volta closure (config override)"]. */
  skipped: string[];
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
let hd: Holidays | undefined;

export function holidayName(dateStr: string, config: Pick<Config, "holiday_overrides">): string | undefined {
  if (config.holiday_overrides.includes(dateStr)) return "Volta closure (config override)";
  hd ??= new Holidays("CA", "NS", { types: ["public"] });
  const [y, m, d] = dateStr.split("-").map(Number);
  const hit = hd.isHoliday(new Date(Date.UTC(y!, m! - 1, d!, 12)));
  if (!hit) return undefined;
  const list = Array.isArray(hit) ? hit : [hit];
  return list[0]?.name;
}

/** The Monday (YYYY-MM-DD) of the week containing `now`, in the configured timezone. */
export function mondayOfWeek(now: Date, timeZone: string): string {
  const p = partsInZone(now, timeZone);
  const dow = WEEKDAYS.indexOf(p.weekday);
  const back = dow === 0 ? 6 : dow - 1;
  return addDays(localDateString(now, timeZone), -back);
}

export function firstWorkdayOfWeek(now: Date, config: Pick<Config, "timezone" | "holiday_overrides">): FirstWorkday {
  const monday = mondayOfWeek(now, config.timezone);
  const skipped: string[] = [];
  for (let i = 0; i < 5; i++) {
    const date = addDays(monday, i);
    const name = holidayName(date, config);
    const weekday = WEEKDAYS[(1 + i) % 7]!;
    if (!name) return { date, weekday, weekMonday: monday, skipped };
    skipped.push(`${date} ${weekday}: ${name}`);
  }
  // A whole week of holidays: fall back to Monday and let the alert say so.
  return { date: monday, weekday: "monday", weekMonday: monday, skipped };
}

/** True when `now` is on the first workday and at or past the reminder time. */
export function reminderDue(now: Date, config: Pick<Config, "timezone" | "holiday_overrides" | "reminder_time">): { due: boolean; firstWorkday: FirstWorkday; localNow: string } {
  const fw = firstWorkdayOfWeek(now, config);
  const p = partsInZone(now, config.timezone);
  const today = localDateString(now, config.timezone);
  const [hh, mm] = config.reminder_time.split(":").map(Number);
  const past = p.hour > hh! || (p.hour === hh && p.minute >= mm!);
  return { due: today === fw.date && past, firstWorkday: fw, localNow: `${today} ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")} ${p.weekday}` };
}

export function addDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const t = new Date(Date.UTC(y!, m! - 1, d! + n));
  return t.toISOString().slice(0, 10);
}
