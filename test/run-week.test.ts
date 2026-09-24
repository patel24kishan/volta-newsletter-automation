import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryAlerter } from "../src/alerts.js";
import { resolveClock } from "../src/clock.js";
import type { Config } from "../src/config.js";
import { runWeek } from "../src/run-week.js";
import { buildDraft, candidateGroups, currentSelection, editItem, setSelection, startReview, type ReviewState } from "../src/review/review.js";
import { periodOf } from "../src/schedule/period.js";
import { SqliteStorage } from "../src/storage.js";
import { loadReview, restoreSession } from "../src/surface/session.js";

const config: Config = {
  timezone: "America/Halifax", draft_layout: "events-first", send_day: "monday", reminder_time: "08:30", content_window_days: 7, events_window_days: 14,
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
    expect(readFileSync(s.drafts[0]!.file_md, "utf8")).toContain("No news to report this week.");
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

describe("runWeek on a monthly cadence (integration)", () => {
  let outDir: string;
  let storage: SqliteStorage;
  beforeEach(() => { outDir = mkdtempSync(join(tmpdir(), "volta-run-monthly-")); storage = new SqliteStorage(":memory:"); });
  afterEach(() => { storage.close(); rmSync(outDir, { recursive: true, force: true }); });

  // Early September news, a September event already held, one coming in October, one in November.
  const monthlyBodies: Record<string, string> = {
    "https://news.test/rss": `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
<item><title>Volta opens applications for its fall cohort</title><link>https://news.test/cohort</link><guid>c</guid><pubDate>Thu, 03 Sep 2026 12:00:00 GMT</pubDate><description>Volta opened applications for its fall cohort of founders. Applications close in October.</description></item>
</channel></rss>`,
    "https://cal.test/ics": ["BEGIN:VCALENDAR", "VERSION:2.0",
      "BEGIN:VEVENT", "UID:demo", "SUMMARY:Demo Night", "DTSTART:20260917T220000Z", "DTEND:20260918T000000Z", "URL:https://www.eventbrite.ca/e/demo", "DESCRIPTION:Founders demo what they built this summer.", "LOCATION:Volta", "END:VEVENT",
      "BEGIN:VEVENT", "UID:mixer", "SUMMARY:Fall Mixer", "DTSTART:20261022T210000Z", "DTEND:20261022T230000Z", "URL:https://www.eventbrite.ca/e/mixer", "DESCRIPTION:Meet the fall cohort.", "LOCATION:Volta", "END:VEVENT",
      "BEGIN:VEVENT", "UID:nov", "SUMMARY:November Talk", "DTSTART:20261105T210000Z", "DTEND:20261105T230000Z", "URL:https://www.eventbrite.ca/e/nov", "END:VEVENT",
      "END:VCALENDAR"].join("\r\n"),
    "https://li.test/company": LI,
  };
  const monthlyFetch = async (url: string) => {
    const b = monthlyBodies[url];
    if (b === undefined) throw new Error(`GET ${url} returned HTTP 503`);
    return b;
  };
  const titles = (s: Awaited<ReturnType<typeof runWeek>>) => s.candidates.map((c) => c.item.title);

  it("reads last month's news and held events and this month's coming ones, through verified drafts", async () => {
    const alerter = new MemoryAlerter();
    const clock = resolveClock(["--now=2026-10-01T11:30:00Z"], {}); // 08:30 in Halifax
    const s = await runWeek({ config: { ...config, cadence: "monthly" }, clock, storage, alerter, outDir, fetchText: monthlyFetch });

    expect(s.sources.map((x) => `${x.id}:${x.status}`)).toEqual(["google-news:ok", "volta-calendar:ok", "volta-linkedin:ok"]);
    expect(titles(s)).toEqual(expect.arrayContaining(["Volta opens applications for its fall cohort", "Demo Night", "Fall Mixer"]));
    expect(titles(s)).not.toContain("November Talk");
    expect(s.drafts.every((d) => d.verified)).toBe(true);
    const md = readFileSync(s.drafts[0]!.file_md, "utf8");
    expect(md).toContain("Fall Mixer");
  });

  it("keeps last month's events apart from this month's, from the run through a draft built days later", async () => {
    const clock = resolveClock(["--now=2026-10-01T11:30:00Z"], {});
    const s = await runWeek({ config: { ...config, cadence: "monthly" }, clock, storage, alerter: new MemoryAlerter(), outDir, fetchText: monthlyFetch });
    const byTitle = (t: string) => s.candidates.find((c) => c.item.title === t)!.item;
    expect(byTitle("Demo Night").event_timing).toBe("past");
    expect(byTitle("Fall Mixer").event_timing).toBe("upcoming");
    // Last month's event is offered, not pre-ticked.
    expect(s.preselected_ids).toContain(byTitle("Fall Mixer").id);
    expect(s.preselected_ids).not.toContain(byTitle("Demo Night").id);

    // The review Claude drives: the list is grouped, and Bader ticks the past event too.
    const st: ReviewState = {
      candidates: [], timeZone: config.timezone, outDir, drafts: new Map(), selections: new Map(), env: {}, campaigns: new Set(),
      session: storage, week: "2026-10", layout: "events-first", now: () => new Date("2026-10-05T14:00:00Z"),
    };
    startReview(st, { candidates: s.candidates, preselectedIds: s.preselected_ids, firstWorkday: s.first_workday, timeZone: config.timezone, clockLabel: clock.label, sourceNotes: [] });
    const groups = candidateGroups(st);
    expect(groups.upcomingEvents.map((c) => c.item.title)).toEqual(["Fall Mixer"]);
    expect(groups.pastEvents.map((c) => c.item.title)).toEqual(["Demo Night"]);
    setSelection(st, [...currentSelection(st), byTitle("Demo Night").id]);

    // Built on 5 October, four days after the run: nothing has moved between sections.
    const built = buildDraft(st, new MemoryAlerter());
    if (!built.ok) throw new Error("expected a verified draft");
    const md = built.draft.markdown;
    const up = md.indexOf("## Upcoming events");
    const past = md.indexOf("## Last month at Volta");
    expect(up).toBeGreaterThanOrEqual(0);
    expect(past).toBeGreaterThan(up);
    expect(md.indexOf("Fall Mixer", up)).toBeLessThan(past);
    expect(md.indexOf("Demo Night", past)).toBeGreaterThan(past);
    expect(md).toMatch(/Held: Thursday, September 17/);
  });

  it("is due on the month's first workday, is saved under the month, and reads as this month's", async () => {
    const clock = resolveClock(["--now=2026-10-01T11:30:00Z"], {});
    const monthlyConfig: Config = { ...config, cadence: "monthly" };
    const s = await runWeek({ config: monthlyConfig, clock, storage, alerter: new MemoryAlerter(), outDir, fetchText: monthlyFetch });
    expect(s).toMatchObject({ period: "2026-10", cadence: "monthly", reminder_due: true, first_workday: { date: "2026-10-01", weekday: "thursday" } });
    const pregenerated = readFileSync(s.drafts[0]!.file_md, "utf8");
    expect(pregenerated).toMatch(/^# Volta this month: /);
    expect(pregenerated).not.toMatch(/this week/i);

    // The review starts on the 1st and is saved under the month ...
    const first: ReviewState = {
      candidates: [], timeZone: config.timezone, outDir, drafts: new Map(), selections: new Map(), env: {}, campaigns: new Set(),
      session: storage, layout: "events-first", cadence: "monthly", now: () => clock.now(),
    };
    startReview(first, { candidates: s.candidates, preselectedIds: s.preselected_ids, firstWorkday: s.first_workday, period: s.period, timeZone: config.timezone, clockLabel: clock.label, sourceNotes: [] });
    // ... so a new chat on 20 October, working the key out from its own date, picks it up.
    const later = new Date("2026-10-20T15:00:00Z");
    const saved = loadReview(storage, periodOf(later, monthlyConfig).key);
    if (!saved || !("snapshot" in saved)) throw new Error("expected the October review");
    const next: ReviewState = { ...first, candidates: [], drafts: new Map(), selections: new Map(), now: () => later };
    restoreSession(next, saved.snapshot);
    const built = buildDraft(next, new MemoryAlerter());
    if (!built.ok) throw new Error("expected a verified draft");
    expect(built.draft.subject).toMatch(/^Volta this month: /);
    expect(built.draft.markdown).toContain("Fall Mixer");
  });

  it("is not due before 08:30 on the first workday, nor on a later day of the month", async () => {
    const monthlyConfig: Config = { ...config, cadence: "monthly" };
    const early = await runWeek({ config: monthlyConfig, clock: resolveClock(["--now=2026-10-01T11:29:00Z"], {}), storage, alerter: new MemoryAlerter(), outDir, fetchText: monthlyFetch });
    expect(early.reminder_due).toBe(false);
    const later = await runWeek({ config: monthlyConfig, clock: resolveClock(["--now=2026-10-02T11:30:00Z"], {}), storage, alerter: new MemoryAlerter(), outDir, fetchText: monthlyFetch });
    expect(later.reminder_due).toBe(false);
    expect(later.period).toBe("2026-10");
  });

  it("keeps the curator's wording through a change of items, a rebuild and a new chat", async () => {
    const clock = resolveClock(["--now=2026-10-01T11:30:00Z"], {});
    const monthlyConfig: Config = { ...config, cadence: "monthly" };
    const s = await runWeek({ config: monthlyConfig, clock, storage, alerter: new MemoryAlerter(), outDir, fetchText: monthlyFetch });
    const id = (t: string) => s.candidates.find((c) => c.item.title === t)!.item.id;
    const fresh = (): ReviewState => ({
      candidates: [], timeZone: config.timezone, outDir, drafts: new Map(), selections: new Map(), env: {}, campaigns: new Set(),
      session: storage, edits: storage, week: s.period, layout: "events-first", cadence: "monthly", now: () => new Date("2026-10-02T13:00:00Z"),
    });
    const st = fresh();
    startReview(st, { candidates: s.candidates, preselectedIds: s.preselected_ids, firstWorkday: s.first_workday, period: s.period, timeZone: config.timezone, clockLabel: clock.label, sourceNotes: [] });

    // Tick, build, then reword the mixer and move it an hour later.
    setSelection(st, [id("Fall Mixer"), id("Volta opens applications for its fall cohort")]);
    expect(editItem(st, id("Fall Mixer"), "summary", "Drinks, demos and the whole fall cohort.")).toHaveProperty("item");
    expect(editItem(st, id("Fall Mixer"), "starts_at", "2026-10-22 19:00")).toHaveProperty("item");
    const first = buildDraft(st, new MemoryAlerter());
    if (!first.ok) throw new Error("expected a verified draft");
    expect(first.draft.markdown).toContain("Drinks, demos and the whole fall cohort.");
    expect(first.draft.markdown).toContain("When: Thursday, October 22, 7:00 pm");

    // Change the items: add last month's Demo Night, drop the news. The edit stays.
    setSelection(st, [id("Fall Mixer"), id("Demo Night")]);
    const second = buildDraft(st, new MemoryAlerter());
    if (!second.ok) throw new Error("expected a verified draft");
    expect(second.draft.markdown).toContain("Drinks, demos and the whole fall cohort.");
    expect(second.draft.markdown).toContain("## Last month at Volta");
    expect(second.draft.markdown).not.toContain("fall cohort of founders");
    expect(second.notes.edited).toEqual([{ id: id("Fall Mixer"), title: "Fall Mixer", fields: ["description", "date and time"] }]);

    // A new chat restores the saved review and still finds the edits.
    const saved = loadReview(storage, s.period);
    if (!saved || !("snapshot" in saved)) throw new Error("expected the saved review");
    const next = fresh();
    restoreSession(next, saved.snapshot);
    const third = buildDraft(next, new MemoryAlerter());
    if (!third.ok) throw new Error("expected a verified draft");
    expect(third.draft.markdown).toContain("Drinks, demos and the whole fall cohort.");
    // The source item itself was never rewritten.
    expect(storage.getItem(id("Fall Mixer"))!.summary).toBe("Meet the fall cohort.");
  });

  it("lists both months of a recurring event, each in its own group (found on live data)", async () => {
    const vibe = (uid: string, start: string) => ["BEGIN:VEVENT", `UID:${uid}`, "SUMMARY:Vibe Coding Meetup", `DTSTART:${start}`, `DTEND:${start}`, `URL:https://www.eventbrite.ca/e/${uid}`, "DESCRIPTION:Build something, share it.", "END:VEVENT"].join("\r\n");
    const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", vibe("vibe-sep", "20260921T210000Z"), vibe("vibe-oct", "20261019T210000Z"), "END:VCALENDAR"].join("\r\n");
    const clock = resolveClock(["--now=2026-10-01T11:30:00Z"], {});
    const s = await runWeek({ config: { ...config, cadence: "monthly" }, clock, storage, alerter: new MemoryAlerter(), outDir, fetchText: async (url) => (url === "https://cal.test/ics" ? ics : monthlyFetch(url)) });
    const g = candidateGroups({ candidates: s.candidates });
    expect(g.pastEvents.map((c) => c.item.date)).toEqual(["2026-09-21T21:00:00.000Z"]);
    expect(g.upcomingEvents.map((c) => c.item.date)).toEqual(["2026-10-19T21:00:00.000Z"]);
    expect(s.merges.filter((m) => m.includes("Vibe Coding"))).toEqual([]);
  });

  it("with the same sources, a weekly run still reads only the last 7 days and the next 14", async () => {
    // The news and Demo Night are older than 7 days and the Fall Mixer is 21 days away, so a
    // weekly run on the same morning finds none of them: the monthly windows made the difference.
    const clock = resolveClock(["--now=2026-10-01T11:30:00Z"], {});
    const s = await runWeek({ config, clock, storage, alerter: new MemoryAlerter(), outDir, fetchText: monthlyFetch });
    expect(titles(s)).toEqual([]);
    expect(s.sources.find((x) => x.id === "volta-calendar")!.warnings.join()).toMatch(/3 event\(s\) outside the window/);
  });
});

describe("sources the curator added himself", () => {
  let outDir: string;
  let storage: SqliteStorage;
  beforeEach(() => { outDir = mkdtempSync(join(tmpdir(), "volta-run-cur-")); storage = new SqliteStorage(":memory:"); });
  afterEach(() => { storage.close(); rmSync(outDir, { recursive: true, force: true }); });

  const clock = () => resolveClock(["--now=2026-09-15T18:00:00Z"], {});
  const EXTRA = `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
<item><title>Volta member raises a seed round - Entrevestor</title><link>https://entrevestor.test/a</link><guid>ea</guid><pubDate>Mon, 14 Sep 2026 09:00:00 GMT</pubDate><description>A Volta member closed a seed round this week. The company is based in Halifax.</description></item>
</channel></rss>`;
  const withExtra = async (url: string) => (url === "https://entrevestor.test/feed" ? EXTRA : fetchText(url));
  const row = (o: Record<string, unknown> = {}) => ({
    id: "cur_entrevestor", kind: "rss", type: "news", url: "https://entrevestor.test/feed", terms: [], channel_id: "",
    fallback_link: "", keywords: [], filtered: false, label: "Entrevestor", enabled: true, ...o,
  });

  it("are fetched with the maintainer's, and their items reach the draft", async () => {
    storage.addCuratorSource(row());
    const s = await runWeek({ config, clock: clock(), storage, alerter: new MemoryAlerter(), outDir, fetchText: withExtra });

    expect(s.sources.map((x) => `${x.id}:${x.status}`)).toContain("cur_entrevestor:ok");
    expect(s.drafts.every((d) => d.verified)).toBe(true);
    expect(readFileSync(s.drafts[0]!.file_md, "utf8")).toContain("Volta member raises a seed round");
  });

  it("are left out when turned off, and the rest of the run is unchanged", async () => {
    storage.addCuratorSource(row({ enabled: false }));
    const s = await runWeek({ config, clock: clock(), storage, alerter: new MemoryAlerter(), outDir, fetchText: withExtra });
    expect(s.sources.map((x) => x.id)).not.toContain("cur_entrevestor");
    expect(s.drafts.every((d) => d.verified)).toBe(true);
  });

  it("never stop the newsletter: a Slack channel that cannot be read is reported, and the draft is still built", async () => {
    // Bader added the channel but the token was never set up, or the bot was never invited.
    storage.addCuratorSource(row({ id: "cur_member-updates", kind: "slack_channel", type: "member_social", url: "", channel_id: "C0C2H7WAUJX" }));
    const alerter = new MemoryAlerter();
    const s = await runWeek({ config, clock: clock(), storage, alerter, outDir, fetchText: withExtra, env: {} });

    const slack = s.sources.find((x) => x.id === "cur_member-updates")!;
    expect(slack.status).toBe("failed");
    expect(slack.error).toContain("SLACK_BOT_TOKEN is not set");
    expect(alerter.sent.some((a) => a.source === "cur_member-updates" && a.level === "error")).toBe(true);
    // The month still has its other sources, and a verified draft.
    expect(s.sources.filter((x) => x.status === "ok").length).toBeGreaterThan(0);
    expect(s.drafts.length).toBeGreaterThan(0);
    expect(s.drafts.every((d) => d.verified)).toBe(true);
  });
});

describe("a curator source's own keywords", () => {
  let outDir: string;
  let storage: SqliteStorage;
  beforeEach(() => { outDir = mkdtempSync(join(tmpdir(), "volta-run-kw-")); storage = new SqliteStorage(":memory:"); });
  afterEach(() => { storage.close(); rmSync(outDir, { recursive: true, force: true }); });

  const clock = () => resolveClock(["--now=2026-09-15T18:00:00Z"], {});
  // A partner's calendar: one event about the sector, one about a parking meeting.
  const PARTNER = ["BEGIN:VCALENDAR", "VERSION:2.0",
    "BEGIN:VEVENT", "UID:ocean", "SUMMARY:Ocean tech demo night", "DTSTART:20260922T220000Z", "DTEND:20260923T000000Z", "URL:https://partner.test/e/ocean", "DESCRIPTION:An evening of ocean technology demos.", "END:VEVENT",
    "BEGIN:VEVENT", "UID:parking", "SUMMARY:Parking committee meeting", "DTSTART:20260923T150000Z", "DTEND:20260923T160000Z", "URL:https://partner.test/e/parking", "DESCRIPTION:Monthly parking committee.", "END:VEVENT",
    "END:VCALENDAR"].join("\r\n");
  const withPartner = async (url: string) => (url === "https://partner.test/ics" ? PARTNER : fetchText(url));
  const calendar = (o: Record<string, unknown> = {}) => ({
    id: "cur_partner", kind: "ics", type: "event", url: "https://partner.test/ics", terms: [], channel_id: "",
    fallback_link: "https://partner.test/events", keywords: [], filtered: false, label: "Partner calendar", enabled: true, ...o,
  });

  it("filters a calendar, which the newsletter never filtered before, and says how many went", async () => {
    storage.addCuratorSource(calendar({ keywords: ["ocean"], filtered: true }));
    const s = await runWeek({ config, clock: clock(), storage, alerter: new MemoryAlerter(), outDir, fetchText: withPartner });

    const partner = s.sources.find((x) => x.id === "cur_partner")!;
    expect(partner.status).toBe("ok");
    expect(partner.items).toBe(1);
    expect(partner.warnings.join("\n")).toContain("1 item(s) dropped as off-topic for this source");
    const md = readFileSync(s.drafts[0]!.file_md, "utf8");
    expect(md).toContain("Ocean tech demo night");
    expect(md).not.toContain("Parking committee meeting");
  });

  it("keeps everything from a calendar he added with no keywords, watchlist or not", async () => {
    storage.addCuratorSource(calendar({ keywords: [], filtered: true }));
    const s = await runWeek({ config, clock: clock(), storage, alerter: new MemoryAlerter(), outDir, fetchText: withPartner });
    expect(s.sources.find((x) => x.id === "cur_partner")!.items).toBe(2);
    expect(s.drafts.every((d) => d.verified)).toBe(true);
  });
});

/**
 * The guarantee Bader depends on: whatever one source does, the newsletter is still prepared and
 * the draft still verifies. One case per kind, since each fails in its own way.
 */
describe("no single source can stop the newsletter", () => {
  let outDir: string;
  let storage: SqliteStorage;
  beforeEach(() => { outDir = mkdtempSync(join(tmpdir(), "volta-run-fail-")); storage = new SqliteStorage(":memory:"); });
  afterEach(() => { storage.close(); rmSync(outDir, { recursive: true, force: true }); });

  const clock = () => resolveClock(["--now=2026-09-15T18:00:00Z"], {});
  const WORKING = ["BEGIN:VCALENDAR", "VERSION:2.0",
    "BEGIN:VEVENT", "UID:mixer", "SUMMARY:Volta Fall Mixer", "DTSTART:20260924T210000Z", "DTEND:20260924T230000Z", "URL:https://www.eventbrite.ca/e/mixer", "DESCRIPTION:Meet the fall cohort at Volta.", "END:VEVENT",
    "END:VCALENDAR"].join("\r\n");

  /** One source that works, so there is always something to build from, plus the broken one. */
  const configWith = (broken: Record<string, unknown>): Config => ({
    ...config,
    sources: [{ id: "good-calendar", kind: "ics", type: "event", url: "https://good.test/ics", enabled: true, fallback_link: "https://voltaeffect.com/events" }, broken as never],
  });
  const bodies = async (url: string) => {
    if (url === "https://good.test/ics") return WORKING;
    throw new Error(`GET ${url} returned HTTP 503`);
  };

  const cases: Array<{ what: string; source: Record<string, unknown>; expect: RegExp }> = [
    { what: "a news feed that is down", source: { id: "news", kind: "rss", type: "news", url: "https://dead.test/rss", enabled: true }, expect: /503/ },
    { what: "a news search that is down", source: { id: "search", kind: "google_news", type: "news", url: "https://news.google.test/rss/search?q=x", enabled: true, terms: ["Volta"] }, expect: /503/ },
    { what: "a calendar that is down", source: { id: "cal", kind: "ics", type: "event", url: "https://dead.test/ics", enabled: true, fallback_link: "https://voltaeffect.com/events" }, expect: /503/ },
    { what: "a LinkedIn page that is down", source: { id: "li", kind: "linkedin_company", type: "linkedin", url: "https://dead.test/company", enabled: true }, expect: /503/ },
    { what: "a Slack channel with no token", source: { id: "slack", kind: "slack_channel", type: "member_social", url: "", enabled: true, channel_id: "C0C2H7WAUJX" }, expect: /SLACK_BOT_TOKEN is not set/ },
    { what: "a manual source misconfigured", source: { id: "manual", kind: "manual", type: "event", url: "", enabled: true, fallback_link: "" }, expect: /fallback_link/ },
    { what: "a kind nothing can read", source: { id: "future", kind: "carrier_pigeon", type: "news", url: "https://x.test", enabled: true }, expect: /fetcher not built/ },
  ];

  for (const c of cases) {
    it(`carries on with ${c.what}`, async () => {
      const alerter = new MemoryAlerter();
      const s = await runWeek({ config: configWith(c.source), clock: clock(), storage, alerter, outDir, fetchText: bodies, env: {} });

      const bad = s.sources.find((x) => x.id === c.source.id)!;
      expect(["failed", "skipped", "empty"]).toContain(bad.status);
      expect(`${bad.error ?? ""} ${bad.warnings.join(" ")}`).toMatch(c.expect);
      // Bader is told, and still gets a newsletter.
      expect(alerter.sent.some((a) => a.source === c.source.id)).toBe(true);
      expect(s.sources.find((x) => x.id === "good-calendar")!.status).toBe("ok");
      expect(s.drafts.length).toBeGreaterThan(0);
      expect(s.drafts.every((d) => d.verified)).toBe(true);
      expect(readFileSync(s.drafts[0]!.file_md, "utf8")).toContain("Volta Fall Mixer");
    });
  }

  it("carries on when a reader itself breaks, rather than losing the whole run", async () => {
    // A bug inside a fetcher, not a source that is merely down: before this, it took the month with it.
    const alerter = new MemoryAlerter();
    const s = await runWeek({
      config: configWith({ id: "breaks", kind: "rss", type: "news", url: "https://boom.test/rss", enabled: true }),
      clock: clock(), storage, alerter, outDir, env: {},
      fetchText: async (url) => { if (url === "https://boom.test/rss") throw Object.assign(new Error("boom"), { name: "TypeError" }); return bodies(url); },
    });
    const bad = s.sources.find((x) => x.id === "breaks")!;
    expect(bad.status).toBe("failed");
    expect(s.drafts.every((d) => d.verified)).toBe(true);
  });

  it("still builds a newsletter when every source fails, and says there is nothing rather than inventing any", async () => {
    const alerter = new MemoryAlerter();
    const s = await runWeek({
      config: { ...config, sources: [{ id: "news", kind: "rss", type: "news", url: "https://dead.test/rss", enabled: true }] },
      clock: clock(), storage, alerter, outDir, fetchText: bodies, env: {},
    });
    expect(s.sources.every((x) => x.status === "failed")).toBe(true);
    expect(s.candidates).toHaveLength(0);
    expect(s.drafts.length).toBeGreaterThan(0);
    expect(s.drafts.every((d) => d.verified)).toBe(true);
    // It says each section is empty in plain words, rather than inventing anything to fill them.
    const md = readFileSync(s.drafts[0]!.file_md, "utf8");
    expect(md).toContain("No upcoming events this week.");
    expect(md).toContain("No news to report this week.");
  });
});

describe("what reaches the newsletter, and what is held back", () => {
  let outDir: string;
  let storage: SqliteStorage;
  beforeEach(() => { outDir = mkdtempSync(join(tmpdir(), "volta-run-hold-")); storage = new SqliteStorage(":memory:"); });
  afterEach(() => { storage.close(); rmSync(outDir, { recursive: true, force: true }); });

  const clock = () => resolveClock(["--now=2026-09-15T18:00:00Z"], {});

  it("drops a story that says Volta but is about somewhere else", async () => {
    const GHANA = `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
<item><title>Volta youth group backs call for Sedina's release</title><link>https://news.test/gh</link><guid>gh</guid><pubDate>Mon, 14 Sep 2026 10:00:00 GMT</pubDate><description>A petition in the Volta Region.</description></item>
<item><title>Volta opens applications for its fall cohort</title><link>https://news.test/hfx</link><guid>hfx</guid><pubDate>Mon, 14 Sep 2026 10:00:00 GMT</pubDate><description>The Halifax hub opened applications.</description></item>
</channel></rss>`;
    const local = { ...config, local_terms: ["Halifax", "Nova Scotia"] };
    const s = await runWeek({ config: local, clock: clock(), storage, alerter: new MemoryAlerter(), outDir, fetchText: async (u) => (u === "https://news.test/rss" ? GHANA : fetchText(u)) });
    const titles = s.candidates.map((c) => c.item.title);
    expect(titles).toContain("Volta opens applications for its fall cohort");
    expect(titles.join(" ")).not.toContain("Sedina");
    expect(s.sources.find((x) => x.id === "google-news")!.warnings.join("\n")).toMatch(/mentions no local place/);
  });

  it("holds back a post that came with no text, and says the source gave only links", async () => {
    // LinkedIn without its JSON-LD: titles are fragments of the web address, useless on their own.
    const BARE = `<html><body><a href="https://www.linkedin.com/posts/voltaeffect_what-happens-when-you-bring-a-room-full-of-activity-7505203691520000000-qA1x">x</a></body></html>`;
    const s = await runWeek({ config, clock: clock(), storage, alerter: new MemoryAlerter(), outDir, fetchText: async (u) => (u === "https://li.test/company" ? BARE : fetchText(u)) });
    const li = s.candidates.filter((c) => c.item.source === "volta-linkedin");
    expect(li.length).toBeGreaterThan(0);
    for (const c of li) {
      expect(c.item.requires_review).toBe(true);
      expect(c.item.hold_note).toContain("only the link");
      expect(s.preselected_ids).not.toContain(c.item.id);
    }
    expect(s.sources.find((x) => x.id === "volta-linkedin")!.warnings.join("\n")).toMatch(/came with no text|fell back/);
  });
});
