/**
 * M3b: a monthly newsletter is due on the month's first workday, is saved under its month, and
 * says "this month". Halifax is UTC-3 in October (ADT).
 */
import { describe, expect, it } from "vitest";
import { loadConfig, validateConfig, type Config } from "../src/config.js";
import { buildDrafts } from "../src/draft/templates.js";
import { rankItems } from "../src/pipeline/rank.js";
import { startReview, type ReviewState } from "../src/review/review.js";
import { dueWindow, periodOf } from "../src/schedule/period.js";
import { whatIsDue } from "../src/schedule/scheduler.js";
import { SqliteStorage } from "../src/storage.js";
import { loadReview } from "../src/surface/session.js";
import { sampleItem } from "./helpers.js";

const TZ = "America/Halifax";
const monthly = { timezone: TZ, holiday_overrides: [] as string[], reminder_time: "08:30", cadence: "monthly" as const };
const weekly = { ...monthly, cadence: "weekly" as const };
const at = (iso: string) => new Date(iso);
const due = (iso: string, sent = false) => whatIsDue(at(iso), monthly, { reminderSent: sent }).reminder;

describe("when a monthly newsletter is due", () => {
  it("is due from 08:30 on the first workday, and late an hour after", () => {
    expect(due("2026-10-01T11:29:00Z")).toBe("not-yet");
    expect(due("2026-10-01T11:30:00Z")).toBe("due");
    expect(due("2026-10-01T12:30:00Z")).toBe("due");
    expect(due("2026-10-01T12:31:00Z")).toBe("due-late");
  });

  it("catches up for a week after the first workday, then gives up", () => {
    expect(due("2026-10-05T14:00:00Z")).toBe("due-late");
    expect(due("2026-10-08T02:59:00Z")).toBe("due-late"); // 23:59 on 7 October
    expect(due("2026-10-08T03:00:00Z")).toBe("missed"); //   00:00 on 8 October
    expect(due("2026-10-20T12:00:00Z")).toBe("missed");
  });

  it("is sent once sent, whatever the day", () => {
    expect(due("2026-10-01T11:30:00Z", true)).toBe("sent");
    expect(due("2026-10-20T12:00:00Z", true)).toBe("sent");
  });

  it("waits for the first workday when the 1st is a weekend or a holiday", () => {
    // 1 November 2026 is a Sunday; Canada Day 2027 is a Thursday.
    expect(due("2026-11-01T15:00:00Z")).toBe("not-yet");
    expect(due("2026-11-02T12:30:00Z")).toBe("due"); // 08:30 AST
    expect(due("2027-07-01T12:00:00Z")).toBe("not-yet");
    expect(whatIsDue(at("2027-07-02T11:30:00Z"), monthly, { reminderSent: false })).toMatchObject({
      reminder: "due", firstWorkday: { date: "2027-07-02", skipped: ["2027-07-01 thursday: Canada Day"] },
    });
  });

  it("names the review by its month, and is never closed", () => {
    const d = whatIsDue(at("2026-12-28T12:00:00Z"), monthly, { reminderSent: false });
    expect(d.week).toBe("2026-12");
    expect(d.reminder).not.toBe("closed");
  });

  it("catches up for as many days as the config says, then gives up", () => {
    const month = { ...monthly, catch_up_days: 31 };
    // September's first workday is Tuesday 1 September; 22 September is inside a 31-day catch-up.
    expect(whatIsDue(at("2026-09-22T16:00:00Z"), month, { reminderSent: false }).reminder).toBe("due-late");
    expect(dueWindow(at("2026-09-22T16:00:00Z"), month).giveUpAt.toISOString()).toBe("2026-10-02T03:00:00.000Z");
    // Without the setting, 7 days, as before.
    expect(whatIsDue(at("2026-09-22T16:00:00Z"), monthly, { reminderSent: false }).reminder).toBe("missed");
  });

  it("only accepts a catch-up of 1 to 31 whole days", () => {
    const base = {
      timezone: TZ, draft_layout: "events-first", send_day: "monday", reminder_time: "08:30", content_window_days: 7, events_window_days: 14,
      watchlist: ["Volta"], holiday_overrides: [], alert_recipients: [], sources: [{ id: "cal", kind: "ics", type: "event", url: "https://x.test/c.ics", enabled: true }],
    };
    expect(validateConfig({ ...base, catch_up_days: 31 }).catch_up_days).toBe(31);
    for (const bad of [0, 32, 2.5, "7"]) expect(() => validateConfig({ ...base, catch_up_days: bad }), String(bad)).toThrow(/catch_up_days must be a whole number of days from 1 to 31/);
  });

  it("leaves the weekly rule as it was: Monday 08:30, given up at the end of Friday", () => {
    const w = dueWindow(at("2026-09-23T12:00:00Z"), weekly);
    expect(w.period.key).toBe("2026-09-21");
    expect(w.dueAt.toISOString()).toBe("2026-09-21T11:30:00.000Z");
    expect(w.giveUpAt.toISOString()).toBe("2026-09-26T03:00:00.000Z");
  });
});

describe("the monthly newsletter's wording", () => {
  const story = sampleItem({ link: "https://news.test/a", title: "Volta launches a program" });

  it("says this month, never this week, and still verifies", () => {
    for (const d of buildDrafts([story], { timeZone: TZ, cadence: "monthly" })) {
      expect(d.subject, d.id).toBe("Volta this month: Volta launches a program");
      expect(d.markdown, d.id).toContain("No upcoming events items this month.");
      expect(d.markdown, d.id).not.toMatch(/this week/i);
      expect(d.verification.ok, d.id).toBe(true);
    }
  });

  it("stays weekly when no cadence is given", () => {
    const d = buildDrafts([story], { timeZone: TZ, layouts: ["events-first"] })[0]!;
    expect(d.subject).toBe("Volta this week: Volta launches a program");
    expect(d.markdown).toContain("No upcoming events items this week.");
  });
});

describe("saving a monthly review", () => {
  it("is saved under its month, so a later chat that month finds it", () => {
    const storage = new SqliteStorage(":memory:");
    try {
      const st: ReviewState = { candidates: [], timeZone: TZ, outDir: ".", drafts: new Map(), selections: new Map(), env: {}, campaigns: new Set(), session: storage, now: () => at("2026-10-01T11:30:00Z") };
      const story = sampleItem({ link: "https://news.test/a" });
      startReview(st, {
        candidates: rankItems([story], at("2026-10-01T11:30:00Z")), preselectedIds: [story.id], period: "2026-10",
        firstWorkday: { date: "2026-10-01", weekday: "thursday", weekMonday: "2026-09-28", skipped: [] }, timeZone: TZ, clockLabel: "test", sourceNotes: [],
      });
      expect(st.week).toBe("2026-10");
      expect(storage.loadSession("2026-09-28")).toBeUndefined();
      // A chat on 20 October works out the same key and picks the review up.
      expect(loadReview(storage, periodOf(at("2026-10-20T15:00:00Z"), monthly).key)).toEqual({ snapshot: expect.objectContaining({ v: 1 }) });
    } finally {
      storage.close();
    }
  });
});

describe("the demo config", () => {
  it("is monthly", async () => {
    const c: Config = await loadConfig("demo/config.json");
    expect(c.cadence).toBe("monthly");
  });
});
