/**
 * Periods and windows (src/schedule/period.ts). Fixed instants throughout; Halifax is UTC-3 in
 * daylight time (ADT) and UTC-4 in standard time (AST), which the month boundaries below cross.
 */
import { describe, expect, it } from "vitest";
import { ConfigError, validateConfig, type Config } from "../src/config.js";
import { firstWorkdayOfWeek } from "../src/schedule/first-workday.js";
import {
  addMonths, describeWindow, firstWorkdayOfMonth, firstWorkdayOfPeriod, inWindow, monthOf, periodOf, windowsFor,
} from "../src/schedule/period.js";

const TZ = "America/Halifax";
const base = { timezone: TZ, holiday_overrides: [] as string[], content_window_days: 7, events_window_days: 14 };
const monthly = { ...base, cadence: "monthly" as const };
const weekly = { ...base, cadence: "weekly" as const };
const at = (iso: string) => new Date(iso);
const iso = (d: Date) => d.toISOString();

describe("periodOf", () => {
  it("keys a monthly period by its month, with its first and next-month days", () => {
    expect(periodOf(at("2026-10-01T11:30:00Z"), monthly)).toEqual({ cadence: "monthly", key: "2026-10", start: "2026-10-01", end: "2026-11-01" });
    expect(periodOf(at("2026-12-15T12:00:00Z"), monthly)).toEqual({ cadence: "monthly", key: "2026-12", start: "2026-12-01", end: "2027-01-01" });
  });

  it("reads the month in Halifax: 23:30 on 30 September is still September there", () => {
    expect(periodOf(at("2026-10-01T02:30:00Z"), monthly).key).toBe("2026-09");
  });

  it("keeps a weekly period keyed by its Monday, and treats a config without a cadence as weekly", () => {
    expect(periodOf(at("2026-09-23T12:00:00Z"), weekly)).toEqual({ cadence: "weekly", key: "2026-09-21", start: "2026-09-21", end: "2026-09-28" });
    expect(periodOf(at("2026-09-23T12:00:00Z"), base).cadence).toBe("weekly");
  });

  it("steps months across year ends", () => {
    expect(addMonths("2026-12", 1)).toBe("2027-01");
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(monthOf(at("2027-01-01T03:59:00Z"), TZ)).toBe("2026-12"); // 23:59 AST on 31 December
  });
});

describe("firstWorkdayOfMonth", () => {
  it("is the 1st when that is an ordinary weekday", () => {
    expect(firstWorkdayOfMonth("2026-10", base)).toMatchObject({ date: "2026-10-01", weekday: "thursday", skipped: [] });
  });

  it("passes over a weekend without listing it", () => {
    // 1 November 2026 is a Sunday.
    expect(firstWorkdayOfMonth("2026-11", base)).toMatchObject({ date: "2026-11-02", weekday: "monday", skipped: [] });
  });

  it("passes over a Nova Scotia holiday and says which", () => {
    expect(firstWorkdayOfMonth("2027-07", base)).toMatchObject({ date: "2027-07-02", weekday: "friday", skipped: ["2027-07-01 thursday: Canada Day"] });
    expect(firstWorkdayOfMonth("2027-01", base)).toMatchObject({ date: "2027-01-04", weekday: "monday", skipped: ["2027-01-01 friday: New Year's Day"] });
  });

  it("passes over a Volta closure from the config", () => {
    const r = firstWorkdayOfMonth("2026-10", { holiday_overrides: ["2026-10-01"] });
    expect(r).toMatchObject({ date: "2026-10-02", weekday: "friday", skipped: ["2026-10-01 thursday: Volta closure (config override)"] });
  });

  it("gives the Monday of the week it falls in", () => {
    expect(firstWorkdayOfMonth("2026-10", base).weekMonday).toBe("2026-09-28");
  });

  it("is chosen by cadence: the month for monthly, the week exactly as before for weekly", () => {
    const now = at("2026-10-14T12:00:00Z");
    expect(firstWorkdayOfPeriod(now, monthly).date).toBe("2026-10-01");
    expect(firstWorkdayOfPeriod(now, weekly)).toEqual(firstWorkdayOfWeek(now, weekly));
  });
});

describe("windowsFor", () => {
  it("weekly: the same day counts as before, and no look back at past events", () => {
    const now = at("2026-09-21T11:30:00Z");
    const w = windowsFor(now, weekly);
    expect(iso(w.content.from)).toBe("2026-09-14T11:30:00.000Z");
    expect(iso(w.content.to)).toBe(iso(now));
    expect(iso(w.upcoming.from)).toBe(iso(now));
    expect(iso(w.upcoming.to)).toBe("2026-10-05T11:30:00.000Z");
    expect(w.past).toBeUndefined();
  });

  it("monthly on 1 October: all of September's content, October's events ahead, September's behind", () => {
    const now = at("2026-10-01T11:30:00Z"); // 08:30 ADT
    const w = windowsFor(now, monthly);
    expect(iso(w.content.from)).toBe("2026-09-01T03:00:00.000Z"); // midnight ADT
    expect(iso(w.content.to)).toBe(iso(now));
    expect(iso(w.upcoming.from)).toBe(iso(now));
    expect(iso(w.upcoming.to)).toBe("2026-11-01T03:00:00.000Z"); // still ADT at midnight; the clocks go back at 02:00
    expect(iso(w.past!.from)).toBe("2026-09-01T03:00:00.000Z");
    expect(iso(w.past!.to)).toBe(iso(now));
  });

  it("uses each boundary's own offset when daylight saving changes within the span", () => {
    const dec = windowsFor(at("2026-12-01T12:30:00Z"), monthly);
    expect(iso(dec.content.from)).toBe("2026-11-01T03:00:00.000Z"); // ADT
    expect(iso(dec.upcoming.to)).toBe("2027-01-01T04:00:00.000Z"); //  AST
    const apr = windowsFor(at("2027-04-01T11:30:00Z"), monthly);
    expect(iso(apr.content.from)).toBe("2027-03-01T04:00:00.000Z"); // AST
    expect(iso(apr.upcoming.to)).toBe("2027-05-01T03:00:00.000Z"); //  ADT
  });

  it("counts a late run from its own month: a catch-up on 5 October still reads from 1 September", () => {
    const w = windowsFor(at("2026-10-05T15:00:00Z"), monthly);
    expect(iso(w.content.from)).toBe("2026-09-01T03:00:00.000Z");
    expect(iso(w.upcoming.to)).toBe("2026-11-01T03:00:00.000Z");
  });

  it("puts an event at the run's exact moment in upcoming, never in both", () => {
    const now = at("2026-10-01T11:30:00Z");
    const w = windowsFor(now, monthly);
    expect(inWindow(now, w.upcoming)).toBe(true);
    expect(inWindow(now, w.past!)).toBe(false);
    expect(inWindow(now.getTime() - 1, w.past!)).toBe(true);
    expect(inWindow(w.upcoming.to, w.upcoming)).toBe(false); // midnight on 1 November is next month
  });

  it("describes a window in local dates", () => {
    const w = windowsFor(at("2026-10-01T11:30:00Z"), monthly);
    expect(describeWindow(w.content, TZ)).toBe("2026-09-01 to 2026-10-01 08:30");
  });
});

describe("the cadence setting", () => {
  const valid = {
    timezone: TZ, draft_layout: "events-first", send_day: "monday", reminder_time: "08:30", content_window_days: 7, events_window_days: 14,
    watchlist: ["Volta"], holiday_overrides: [], alert_recipients: [],
    sources: [{ id: "cal", kind: "ics", type: "event", url: "https://x.test/cal.ics", enabled: true }],
  };

  it("is optional, and accepts weekly or monthly", () => {
    expect(validateConfig(valid).cadence).toBeUndefined();
    expect(validateConfig({ ...valid, cadence: "monthly" }).cadence).toBe("monthly");
    expect(validateConfig({ ...valid, cadence: "weekly" }).cadence).toBe("weekly");
  });

  it("rejects anything else, naming the choices", () => {
    expect(() => validateConfig({ ...valid, cadence: "fortnightly" })).toThrow(ConfigError);
    expect(() => validateConfig({ ...valid, cadence: "fortnightly" })).toThrow(/cadence must be one of weekly, monthly/);
  });

  it("is what the windows follow", () => {
    const c = validateConfig({ ...valid, cadence: "monthly" }) as Config;
    expect(windowsFor(at("2026-10-01T11:30:00Z"), c).past).toBeDefined();
  });
});
