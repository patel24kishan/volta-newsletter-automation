/**
 * Integration: an event the curator added with a picture on their computer goes through a real
 * monthly run alongside the calendar, into the draft, and out to the email platform as a hosted
 * image, while the calendar's own events stay exactly as they were.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryAlerter } from "../src/alerts.js";
import { resolveClock } from "../src/clock.js";
import type { Config } from "../src/config.js";
import { MailchimpPublisher } from "../src/publish/mailchimp.js";
import { addEvent, approve, buildDraft, candidateGroups, currentSelection, setSelection, startReview, type ReviewState } from "../src/review/review.js";
import { runWeek } from "../src/run-week.js";
import { SqliteStorage } from "../src/storage.js";

const config: Config = {
  timezone: "America/Halifax", cadence: "monthly", draft_layout: "events-first", send_day: "monday", reminder_time: "08:30",
  content_window_days: 7, events_window_days: 14, watchlist: ["Volta"], holiday_overrides: [], alert_recipients: [],
  sources: [
    { id: "volta-calendar", kind: "ics", type: "event", url: "https://cal.test/ics", enabled: true },
    { id: "manual-events", kind: "manual", type: "event", url: "", enabled: true, fallback_link: "https://voltaeffect.com/events" },
  ],
};
const ICS = ["BEGIN:VCALENDAR", "VERSION:2.0",
  "BEGIN:VEVENT", "UID:mixer", "SUMMARY:Fall Mixer", "DTSTART:20261022T210000Z", "DTEND:20261022T230000Z", "URL:https://www.eventbrite.ca/e/mixer", "DESCRIPTION:Meet the fall cohort.", "END:VEVENT",
  "END:VCALENDAR"].join("\r\n");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

/** The real Mailchimp publisher, with only the network replaced: every request it makes is recorded. */
function mailchimp() {
  const calls: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const method = init?.method ?? "GET";
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : {} });
    const body = path.endsWith("/file-manager/files") ? { full_size_url: `https://mcusercontent.test/${String(calls.at(-1)!.body.name)}` }
      : path.endsWith("/campaigns") ? { id: "camp_1", web_id: 42 } : {};
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof globalThis.fetch;
  return { publisher: new MailchimpPublisher({ apiKey: "k-us21", listId: "L1", fromName: "Volta", replyTo: "hello@volta.test", fetch }), calls };
}

let dir: string;
let storage: SqliteStorage;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "volta-img-int-")); storage = new SqliteStorage(join(dir, "db.sqlite")); });
afterEach(() => { storage.close(); rmSync(dir, { recursive: true, force: true }); });

describe("an added event with an image, end to end", () => {
  it("is fetched with the month, built into the preview, and sent to the platform as a hosted image", async () => {
    const poster = join(dir, "demo-night.png");
    writeFileSync(poster, PNG);
    const { publisher: mail, calls } = mailchimp();
    const clock = resolveClock(["--now=2026-10-01T11:30:00Z"], {});
    const st = (): ReviewState => ({
      candidates: [], timeZone: config.timezone, outDir: dir, drafts: new Map(), selections: new Map(), env: { ALLOW_LIVE: "1" }, campaigns: new Set(),
      session: storage, edits: storage, storage, manualSource: { ...config.sources[1]!, fallback_link: "https://voltaeffect.com/events" },
      week: "2026-10", layout: "events-first", cadence: "monthly", now: () => clock.now(), publisher: mail, audience: { audienceName: "Test", memberCount: 2 },
    });

    // Added in September for October, before the month's run.
    const early = st();
    startReview(early, { candidates: [], preselectedIds: [], period: "2026-09", firstWorkday: { date: "2026-09-01", weekday: "tuesday", weekMonday: "2026-08-31", skipped: [] }, timeZone: config.timezone, clockLabel: "test", sourceNotes: [] });
    const added = addEvent(early, { title: "Founder Demo Night", date: "2026-10-15", time: "19:00", location: "Volta", description: "Founders show what they built.", link: "", image: poster });
    expect(added).toHaveProperty("item");

    // The October run fetches it with the calendar.
    const run = await runWeek({ config, clock, storage, alerter: new MemoryAlerter(), outDir: dir, fetchText: async () => ICS });
    const review = st();
    startReview(review, { candidates: run.candidates, preselectedIds: run.preselected_ids, firstWorkday: run.first_workday, period: run.period, timeZone: config.timezone, clockLabel: clock.label, sourceNotes: [] });
    const upcoming = candidateGroups(review).upcomingEvents.map((c) => c.item);
    expect(upcoming.map((i) => i.title)).toEqual(["Founder Demo Night", "Fall Mixer"]);
    expect(upcoming[0]!.image).toBe(poster);

    setSelection(review, upcoming.map((i) => i.id));
    expect(currentSelection(review)).toHaveLength(2);
    const built = buildDraft(review, new MemoryAlerter());
    if (!built.ok) throw new Error("expected a verified draft");
    expect(built.draft.html).toContain('alt="Founder Demo Night"');
    expect(built.draft.html).toContain("data:image/png;base64,");

    expect((await approve(review, built.key)).status).toBe("created");
    // Upload first, then the campaign, then its content: the email never points at the local file.
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /3.0/file-manager/files", "POST /3.0/campaigns", "PUT /3.0/campaigns/camp_1/content"]);
    expect(calls[0]!.body).toEqual({ name: "demo-night.png", file_data: PNG.toString("base64") });
    const sent = String(calls[2]!.body.html);
    expect(sent).toContain('<img src="https://mcusercontent.test/demo-night.png" alt="Founder Demo Night"');
    expect(sent).not.toContain("data:image");
    // The calendar event is untouched: same text, no image.
    expect(sent).toContain("Meet the fall cohort.");
    expect((sent.match(/<img /g) ?? []).length).toBe(1);
  });
});
