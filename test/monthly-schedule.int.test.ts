/**
 * Integration: the schedule decision on a monthly cadence, driving a real weekly run (fixtures, no
 * network) and saving the review under the month. The scheduler is what a timer calls; the Claude
 * trigger will make the same decision, so this proves the decision and the pipeline agree.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryAlerter } from "../src/alerts.js";
import type { Clock } from "../src/clock.js";
import type { Config } from "../src/config.js";
import { runWeek } from "../src/run-week.js";
import { WeeklyScheduler } from "../src/schedule/scheduler.js";
import { SqliteStorage } from "../src/storage.js";
import type { ReminderInput } from "../src/surface/blocks.js";
import type { SlackClient, SurfaceState } from "../src/surface/handlers.js";
import { serialQueue } from "../src/surface/serial.js";
import { loadReview } from "../src/surface/session.js";

const config: Config = {
  timezone: "America/Halifax", cadence: "monthly", draft_layout: "events-first", send_day: "monday", reminder_time: "08:30",
  content_window_days: 7, events_window_days: 14, watchlist: ["Volta"], holiday_overrides: [], alert_recipients: [],
  sources: [{ id: "volta-calendar", kind: "ics", type: "event", url: "https://cal.test/ics", enabled: true }],
};
const ICS = ["BEGIN:VCALENDAR", "VERSION:2.0",
  "BEGIN:VEVENT", "UID:demo", "SUMMARY:Demo Night", "DTSTART:20260917T220000Z", "DTEND:20260918T000000Z", "URL:https://www.eventbrite.ca/e/demo", "END:VEVENT",
  "BEGIN:VEVENT", "UID:mixer", "SUMMARY:Fall Mixer", "DTSTART:20261022T210000Z", "DTEND:20261022T230000Z", "URL:https://www.eventbrite.ca/e/mixer", "END:VEVENT",
  "END:VCALENDAR"].join("\r\n");

class MovableClock implements Clock {
  overridden = true;
  label = "test";
  constructor(public current: Date) {}
  now() { return new Date(this.current.getTime()); }
}

class FakeSlack implements SlackClient {
  posts: string[] = [];
  async postMessage(args: { channel: string; text: string }) { this.posts.push(args.text); return { ts: `${this.posts.length}.0`, channel: args.channel }; }
  async openDm(user: string) { return `D_${user}`; }
}

let dir: string;
let storage: SqliteStorage;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "volta-monthly-sched-")); storage = new SqliteStorage(join(dir, "db.sqlite")); });
afterEach(() => { storage.close(); rmSync(dir, { recursive: true, force: true }); });

describe("the monthly schedule, end to end", () => {
  it("runs the month once on its first workday, saves it under the month, and not again that month", async () => {
    const clock = new MovableClock(new Date("2026-09-30T15:00:00Z"));
    const client = new FakeSlack();
    let runs = 0;
    const st: SurfaceState = { candidates: [], timeZone: config.timezone, outDir: dir, drafts: new Map(), selections: new Map(), env: { ALLOW_LIVE: "1" }, campaigns: new Set(), session: storage };
    const scheduler = new WeeklyScheduler({
      config, clock, storage, st, client, userId: "U", alerter: new MemoryAlerter(), queue: serialQueue(), isLive: () => true, log: () => undefined,
      prepareWeek: async (): Promise<ReminderInput> => {
        runs++;
        const r = await runWeek({ config, clock, storage, alerter: new MemoryAlerter(), outDir: dir, fetchText: async () => ICS });
        return { candidates: r.candidates, preselectedIds: r.preselected_ids, firstWorkday: r.first_workday, period: r.period, timeZone: config.timezone, clockLabel: clock.label, sourceNotes: [] };
      },
    });

    await scheduler.tick(); // 30 September: still September's period, and nothing is due in it
    expect(runs).toBe(0);

    clock.current = new Date("2026-10-01T11:30:00Z"); // 08:30 on Thursday 1 October
    await scheduler.tick();
    expect(runs).toBe(1);
    expect(client.posts).toHaveLength(1);
    const saved = loadReview(storage, "2026-10");
    if (!saved || !("snapshot" in saved)) throw new Error("expected the review saved under 2026-10");
    const titles = saved.snapshot.reminder.input.candidates.map((c) => c.item.title);
    expect(titles).toEqual(expect.arrayContaining(["Demo Night", "Fall Mixer"]));
    expect(st.week).toBe("2026-10");

    for (const later of ["2026-10-05T14:00:00Z", "2026-10-20T12:00:00Z"]) {
      clock.current = new Date(later);
      await scheduler.tick();
    }
    expect(runs).toBe(1);
    expect(client.posts).toHaveLength(1);
  });
});
