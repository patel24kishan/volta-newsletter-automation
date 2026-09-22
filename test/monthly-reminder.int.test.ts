/**
 * Integration: the monthly reminder as the scheduled task in the Claude app will call it, every
 * morning, through a real MCP client, on fixture sources. The clock moves the way days pass.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryAlerter } from "../src/alerts.js";
import type { Clock } from "../src/clock.js";
import type { Config } from "../src/config.js";
import { createNewsletterServer } from "../src/mcp/newsletter-server.js";
import { runWeek } from "../src/run-week.js";
import { SqliteStorage } from "../src/storage.js";

const config: Config = {
  timezone: "America/Halifax", cadence: "monthly", draft_layout: "events-first", send_day: "monday", reminder_time: "08:30",
  content_window_days: 7, events_window_days: 14, watchlist: ["Volta"], holiday_overrides: [], alert_recipients: [],
  sources: [
    { id: "news-volta", kind: "rss", type: "news", url: "https://news.test/rss", enabled: true },
    { id: "volta-calendar", kind: "ics", type: "event", url: "https://cal.test/ics", enabled: true },
  ],
};
// The news search finds nothing this month; the calendar has one past and one coming event.
const BODIES: Record<string, string> = {
  "https://news.test/rss": `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title></channel></rss>`,
  "https://cal.test/ics": ["BEGIN:VCALENDAR", "VERSION:2.0",
    "BEGIN:VEVENT", "UID:demo", "SUMMARY:Demo Night", "DTSTART:20260917T220000Z", "DTEND:20260918T000000Z", "URL:https://www.eventbrite.ca/e/demo", "END:VEVENT",
    "BEGIN:VEVENT", "UID:mixer", "SUMMARY:Fall Mixer", "DTSTART:20261022T210000Z", "DTEND:20261022T230000Z", "URL:https://www.eventbrite.ca/e/mixer", "END:VEVENT",
    "END:VCALENDAR"].join("\r\n"),
};

class MovableClock implements Clock {
  overridden = true;
  label = "test";
  constructor(public current: Date) {}
  now() { return new Date(this.current.getTime()); }
  at(iso: string) { this.current = new Date(iso); }
}

let dir: string;
let storage: SqliteStorage;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "volta-reminder-")); storage = new SqliteStorage(join(dir, "db.sqlite")); });
afterEach(() => { storage.close(); rmSync(dir, { recursive: true, force: true }); });

/** One copy of the server, as the Claude app starts it; `runs` counts real fetches. */
async function server(clock: Clock) {
  let runs = 0;
  const alerter = new MemoryAlerter();
  const s = createNewsletterServer({
    config, clock, storage, alerter, outDir: dir, env: { ALLOW_LIVE: "0" },
    runPeriod: async () => { runs++; return runWeek({ config, clock, storage, alerter: new MemoryAlerter(), outDir: dir, fetchText: async (u) => BODIES[u] ?? "" }); },
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "scheduled-task", version: "1" });
  await Promise.all([s.connect(a), client.connect(b)]);
  const call = async (name: string) => ((await client.callTool({ name, arguments: {} })) as { content: Array<{ text: string }> }).content[0]!.text;
  return { reminder: () => call("monthly_reminder"), call, runs: () => runs, alerter, close: () => client.close() };
}
const firstLine = (t: string) => t.split("\n")[0];

describe("the monthly reminder, morning by morning", () => {
  it("stays quiet before the first workday, greets once on it, and stays quiet after, even across a restart", async () => {
    const clock = new MovableClock(new Date("2026-10-01T11:29:00Z")); // 08:29 on Thursday 1 October
    const app = await server(clock);

    const early = await app.reminder();
    expect(early).toBe("NOTHING_DUE\nOctober's newsletter is due Thursday 1 October at 08:30.");
    expect(app.runs()).toBe(0);

    clock.at("2026-10-01T11:37:00Z"); // the 08:30 run, a few minutes late as scheduled tasks are
    const greeting = await app.reminder();
    expect(firstLine(greeting)).toBe("GREETING");
    expect(greeting).toContain("Good morning Bader. October's newsletter is prepared.");
    expect(greeting).toContain("- Upcoming events: 1\n- Last month's events: 1\n- News and updates: 0");
    expect(greeting).toContain("- Pre-ticked: 1: Fall Mixer");
    expect(greeting).toContain("Needs your attention:\n- news-volta found nothing this time.");
    expect(app.runs()).toBe(1);
    // The review is ready for Bader to carry on from.
    expect(await app.call("list_candidates")).toMatch(/\[x\] Fall Mixer/);

    clock.at("2026-10-02T11:35:00Z");
    expect(await app.reminder()).toBe("NOTHING_DUE\nBader was already reminded about October's newsletter.");
    await app.close();

    const restarted = await server(clock);
    expect(firstLine(await restarted.reminder())).toBe("NOTHING_DUE");
    expect(restarted.runs()).toBe(0);
    await restarted.close();
  });

  it("catches up late if the computer was off, and says so", async () => {
    const clock = new MovableClock(new Date("2026-10-05T18:00:00Z")); // Monday 5 October, 15:00: first run since the 1st
    const app = await server(clock);
    const greeting = await app.reminder();
    expect(firstLine(greeting)).toBe("GREETING");
    expect(greeting).toContain("Good afternoon Bader. October's newsletter is prepared. This reminder is late: it was due Thursday 1 October at 08:30.");
    await app.close();
  });

  it("does not fetch again when Bader already prepared the month himself", async () => {
    const clock = new MovableClock(new Date("2026-10-01T10:00:00Z")); // 07:00, before the reminder
    const app = await server(clock);
    await app.call("prepare_month");
    clock.at("2026-10-01T11:40:00Z");
    const greeting = await app.reminder();
    expect(firstLine(greeting)).toBe("GREETING");
    expect(greeting).toContain("news-volta found nothing this time."); // remembered from his own run
    expect(app.runs()).toBe(1);
    await app.close();
  });

  it("gives up after a week, tells Bader once, and raises one alert", async () => {
    const clock = new MovableClock(new Date("2026-10-08T12:00:00Z")); // a week after the first workday
    const app = await server(clock);
    const missed = await app.reminder();
    expect(firstLine(missed)).toBe("MISSED");
    expect(missed).toContain("the reminder for October's newsletter was due Thursday 1 October at 08:30 and could not be shown within a week");
    expect(app.runs()).toBe(0); // nothing prepared on its own that late
    expect(await app.reminder()).toBe("NOTHING_DUE\nOctober's reminder was missed, and Bader has already been told.");
    expect(app.alerter.sent.filter((a) => a.source === "schedule")).toHaveLength(1);
    await app.close();
  });

  it("greets once when two runs overlap", async () => {
    const clock = new MovableClock(new Date("2026-10-01T11:40:00Z"));
    const a = await server(clock);
    const b = await server(clock);
    const [x, y] = await Promise.all([a.reminder(), b.reminder()]);
    expect([firstLine(x), firstLine(y)].sort()).toEqual(["GREETING", "NOTHING_DUE"]);
    await a.close();
    await b.close();
  });
});
