import { describe, expect, it } from "vitest";
import { addDays, firstWorkdayOfWeek, holidayName, mondayOfWeek, reminderDue } from "../src/schedule/first-workday.js";

const cfg = { timezone: "America/Halifax", holiday_overrides: ["2026-10-12"], reminder_time: "08:30" };
const at = (s: string) => new Date(s);

describe("holidayName", () => {
  it("knows Nova Scotia statutory holidays and config overrides, and nothing else", () => {
    expect(holidayName("2026-09-07", cfg)).toMatch(/Labour Day/);
    expect(holidayName("2026-02-16", cfg)).toMatch(/Heritage Day/);
    expect(holidayName("2026-12-25", cfg)).toMatch(/Christmas/);
    expect(holidayName("2026-10-12", cfg)).toMatch(/config override/); // Thanksgiving is not statutory in NS
    expect(holidayName("2026-10-12", { holiday_overrides: [] })).toBeUndefined();
    expect(holidayName("2026-09-14", cfg)).toBeUndefined();
  });
});

describe("mondayOfWeek", () => {
  it("finds Monday in Halifax time, including from a Sunday and from a UTC instant that is still Sunday locally", () => {
    expect(mondayOfWeek(at("2026-09-16T12:00:00Z"), "America/Halifax")).toBe("2026-09-14");
    expect(mondayOfWeek(at("2026-09-20T12:00:00Z"), "America/Halifax")).toBe("2026-09-14");
    expect(mondayOfWeek(at("2026-09-21T01:00:00Z"), "America/Halifax")).toBe("2026-09-14"); // 22:00 Sunday in Halifax
    expect(addDays("2026-12-30", 3)).toBe("2027-01-02");
  });
});

describe("firstWorkdayOfWeek", () => {
  it("is Monday in an ordinary week", () => {
    expect(firstWorkdayOfWeek(at("2026-09-15T12:00:00Z"), cfg)).toMatchObject({ date: "2026-09-14", weekday: "monday", skipped: [] });
  });
  it("shifts to Tuesday after Thanksgiving via the config override (user requirement)", () => {
    const fw = firstWorkdayOfWeek(at("2026-10-12T12:00:00Z"), cfg);
    expect(fw).toMatchObject({ date: "2026-10-13", weekday: "tuesday" });
    expect(fw.skipped).toEqual(["2026-10-12 monday: Volta closure (config override)"]);
  });
  it("shifts to Tuesday after Labour Day via the statutory table", () => {
    expect(firstWorkdayOfWeek(at("2026-09-09T12:00:00Z"), cfg)).toMatchObject({ date: "2026-09-08", weekday: "tuesday" });
  });
  it("skips several closure days in a row", () => {
    const c = { ...cfg, holiday_overrides: ["2026-12-28", "2026-12-29", "2026-12-30"] };
    expect(firstWorkdayOfWeek(at("2026-12-28T12:00:00Z"), c)).toMatchObject({ date: "2026-12-31", weekday: "thursday" });
  });
});

describe("reminderDue", () => {
  it("is due only on the first workday at or after the reminder time, in Halifax", () => {
    expect(reminderDue(at("2026-09-14T11:30:00Z"), cfg).due).toBe(true); // Mon 08:30 ADT
    expect(reminderDue(at("2026-09-14T11:29:00Z"), cfg).due).toBe(false);
    expect(reminderDue(at("2026-09-15T12:00:00Z"), cfg).due).toBe(false); // Tuesday of a normal week
    expect(reminderDue(at("2026-10-12T13:00:00Z"), cfg).due).toBe(false); // Thanksgiving Monday
    const tue = reminderDue(at("2026-10-13T11:30:00Z"), cfg);
    expect(tue.due).toBe(true);
    expect(tue.localNow).toBe("2026-10-13 08:30 tuesday");
  });
});
