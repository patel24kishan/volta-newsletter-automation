import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryAlerter } from "../src/alerts.js";
import { resolveClock } from "../src/clock.js";
import type { Config } from "../src/config.js";
import { runWeek } from "../src/run-week.js";
import { SqliteStorage } from "../src/storage.js";

const config: Config = {
  timezone: "America/Halifax", send_day: "monday", reminder_time: "08:30", content_window_days: 7, events_window_days: 14,
  watchlist: ["Volta"], holiday_overrides: ["2026-10-12"], alert_recipients: ["bader"],
  sources: [
    { id: "google-news", kind: "rss", type: "news", url: "https://news.test/rss", enabled: true },
    { id: "volta-calendar", kind: "ics", type: "event", url: "https://cal.test/ics", enabled: true, fallback_link: "https://voltaeffect.com/events" },
    { id: "volta-linkedin", kind: "linkedin_company", type: "linkedin", url: "https://li.test/company", enabled: true },
  ],
};

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
<item><title>Volta Launches New AI-Focused Program - Entrevestor</title><link>https://news.test/a</link><guid>a</guid><pubDate>Mon, 14 Sep 2026 10:00:00 GMT</pubDate><description>Volta launched a new program for founders. It starts in October.</description></item>
</channel></rss>`;
const ICS = ["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:yoga", "SUMMARY:Yoga", "DTSTART:20260924T104500Z", "DTEND:20260924T114500Z", "URL:https://www.eventbrite.ca/e/yoga", "DESCRIPTION:Join us for a 1-hour guided yoga session.", "LOCATION:Volta", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
const LI = `<html><head><script type="application/ld+json">${JSON.stringify({ "@graph": [{ "@type": "DiscussionForumPosting", datePublished: "2026-09-15T16:01:07Z", url: "https://www.linkedin.com/posts/voltaeffect_yoga-activity-7505656961221419008-q", text: "Will we see you next Thursday? On September 24, join us for a 1-hour guided yoga session." }] })}</script></head></html>`;

const bodies: Record<string, string> = { "https://news.test/rss": RSS, "https://cal.test/ics": ICS, "https://li.test/company": LI };
const fetchText = async (url: string) => {
  const b = bodies[url];
  if (b === undefined) throw new Error(`GET ${url} returned HTTP 503`);
  return b;
};

describe("runWeek", () => {
  let outDir: string;
  let storage: SqliteStorage;
  beforeEach(() => { outDir = mkdtempSync(join(tmpdir(), "volta-run-")); storage = new SqliteStorage(":memory:"); });
  afterEach(() => { storage.close(); rmSync(outDir, { recursive: true, force: true }); });

  it("runs fetch through verified drafts and writes every output, sending nothing", async () => {
    const alerter = new MemoryAlerter();
    const clock = resolveClock(["--now=2026-09-15T18:00:00Z"], {});
    const s = await runWeek({ config, clock, storage, alerter, outDir, fetchText });

    expect(s.sources.map((x) => `${x.id}:${x.status}`)).toEqual(["google-news:ok", "volta-calendar:ok", "volta-linkedin:ok"]);
    expect(s.fetched).toBe(3);
    expect(s.after_dedupe).toBe(2); // the LinkedIn yoga post folds into the Yoga event
    expect(s.merges).toHaveLength(1);
    expect(storage.countItems()).toBe(3);
    expect(s.drafts.every((d) => d.verified)).toBe(true);
    for (const d of s.drafts) {
      expect(existsSync(d.file_md)).toBe(true);
      expect(existsSync(d.file_html)).toBe(true);
      expect(readFileSync(d.file_md, "utf8")).toContain("https://www.linkedin.com/posts/voltaeffect_yoga-activity-7505656961221419008-q");
    }
    expect(existsSync(join(outDir, "candidates.json"))).toBe(true);
    const run = JSON.parse(readFileSync(join(outDir, "run.json"), "utf8"));
    expect(run.first_workday).toMatchObject({ date: "2026-09-14", weekday: "monday" });
    expect(run.reminder_due).toBe(false); // Tuesday
    expect(alerter.sent).toEqual([]);
  });

  it("alerts on a failed source and an empty source, and still produces drafts that say so", async () => {
    const alerter = new MemoryAlerter();
    const clock = resolveClock(["--now=2026-09-15T18:00:00Z"], {});
    const partial = async (url: string) => (url === "https://news.test/rss" ? `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title></channel></rss>` : fetchText(url));
    const broken: Config = { ...config, sources: config.sources.map((x) => (x.id === "volta-linkedin" ? { ...x, url: "https://li.test/down" } : x)) };
    const s = await runWeek({ config: broken, clock, storage, alerter, outDir, fetchText: partial });

    expect(s.sources.map((x) => `${x.id}:${x.status}`)).toEqual(["google-news:empty", "volta-calendar:ok", "volta-linkedin:failed"]);
    expect(alerter.sent.map((a) => `${a.level}:${a.source}`)).toEqual(["warning:google-news", "error:volta-linkedin"]);
    expect(alerter.sent[1]!.message).toMatch(/HTTP 503/);
    expect(readFileSync(s.drafts[1]!.file_md, "utf8")).toContain("No in the news items this week.");
  });

  it("reports the Thanksgiving shift and a due reminder when run as Tuesday 08:30 after the holiday", async () => {
    const alerter = new MemoryAlerter();
    const clock = resolveClock(["--now=2026-10-13T08:30:00-03:00"], {});
    const s = await runWeek({ config, clock, storage, alerter, outDir, fetchText });
    expect(s.first_workday).toMatchObject({ date: "2026-10-13", weekday: "tuesday" });
    expect(s.reminder_due).toBe(true);
    expect(alerter.sent.some((a) => a.source === "schedule" && /config override/.test(a.message))).toBe(true);
  });
});
