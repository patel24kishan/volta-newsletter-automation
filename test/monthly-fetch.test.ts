/**
 * M2: each source reads the monthly windows. The run is on Thursday 1 October 2026 at 08:30 in
 * Halifax (11:30Z), so content and past events run from 1 September 00:00 ADT (03:00Z) to the run,
 * and upcoming events from the run to 1 November 00:00 ADT (03:00Z).
 */
import { describe, expect, it } from "vitest";
import { resolveClock } from "../src/clock.js";
import type { Config, SourceConfig } from "../src/config.js";
import { IcsFetcher } from "../src/fetchers/ics.js";
import { LinkedInCompanyFetcher } from "../src/fetchers/linkedin.js";
import { ManualEventsFetcher } from "../src/fetchers/manual.js";
import { RssFetcher } from "../src/fetchers/rss.js";
import { SlackChannelFetcher } from "../src/fetchers/slack-channel.js";
import { windowsFor } from "../src/schedule/period.js";
import { SqliteStorage } from "../src/storage.js";

const clock = resolveClock(["--now=2026-10-01T11:30:00Z"], {});
function cfg(cadence: Config["cadence"] = "monthly"): Config {
  return {
    timezone: "America/Halifax", draft_layout: "events-first", send_day: "monday", reminder_time: "08:30", content_window_days: 7, events_window_days: 14,
    watchlist: ["Volta"], holiday_overrides: [], alert_recipients: [], sources: [], ...(cadence ? { cadence } : {}),
  };
}

const CRLF = "\r\n";
const vevent = (uid: string, start: string, end = start) =>
  ["BEGIN:VEVENT", `UID:${uid}`, `SUMMARY:${uid}`, `DTSTART:${start}`, `DTEND:${end}`, `URL:https://x.test/${uid}`, "END:VEVENT"].join(CRLF);
const calendar = (...events: string[]) => ["BEGIN:VCALENDAR", "VERSION:2.0", ...events, "END:VCALENDAR"].join(CRLF) + CRLF;
const ICS_SOURCE: SourceConfig = { id: "volta-calendar", kind: "ics", type: "event", url: "https://cal.test/ics", enabled: true };

describe("the calendar, monthly", () => {
  const body = calendar(
    vevent("august-late", "20260831T200000Z"), //    31 Aug, before the look back
    vevent("september-held", "20260910T210000Z"), // held last month
    vevent("first-of-month-early", "20260901T031000Z"), // 00:10 ADT on 1 Sep: just inside
    vevent("this-morning", "20261001T100000Z", "20261001T110000Z"), // over by 08:30 today: held
    vevent("in-progress", "20260930T200000Z", "20261002T200000Z"), // started yesterday, still on
    vevent("october-coming", "20261020T210000Z"),
    vevent("november", "20261101T040000Z"), //         01:00 ADT on 1 Nov: next month
  );

  it("keeps last month's held events and this month's coming ones, and nothing either side", async () => {
    const r = await new IcsFetcher().fetch(ICS_SOURCE, { config: cfg(), clock, fetchText: async () => body });
    expect(r.items.map((i) => i.title)).toEqual(["first-of-month-early", "september-held", "in-progress", "this-morning", "october-coming"]);
    expect(r.warnings.join("\n")).toMatch(/2 event\(s\) outside the window \(held 2026-09-01 to 2026-10-01 08:30, or coming 2026-10-01 08:30 to 2026-11-01\)/);
  });

  it("weekly keeps only what is coming in the next 14 days, as before", async () => {
    const r = await new IcsFetcher().fetch(ICS_SOURCE, { config: cfg("weekly"), clock, fetchText: async () => body });
    expect(r.items.map((i) => i.title)).toEqual(["in-progress"]);
  });

  it("reads the windows the run passes, not its own clock", async () => {
    const windows = windowsFor(new Date("2026-10-15T12:00:00Z"), cfg());
    const r = await new IcsFetcher().fetch(ICS_SOURCE, { config: cfg(), clock, windows, fetchText: async () => body });
    // From 15 October: this morning and yesterday's events are now held, and 20 October is ahead.
    expect(r.items.map((i) => i.title)).toContain("october-coming");
    expect(r.items.map((i) => i.title)).not.toContain("november");
  });
});

describe("manually added events, monthly", () => {
  /**
   * The look back bounds the past, so August has aged off. Nothing bounds the future: an event the
   * curator typed for November is his decision to print it, and a refresh that quietly dropped it
   * left him with a newsletter missing the event he had just added to it.
   */
  it("include last month's and this month's, and one he typed for a later month", async () => {
    const storage = new SqliteStorage(":memory:");
    try {
      const add = (title: string, starts_at: string) => storage.addManualEvent({ title, starts_at, location: "", description: "", link: "" });
      add("Held in September", "2026-09-18T22:00:00.000Z");
      add("Coming in October", "2026-10-22T22:00:00.000Z");
      add("In August", "2026-08-20T22:00:00.000Z");
      add("In November", "2026-11-05T22:00:00.000Z");
      const source: SourceConfig = { id: "manual-events", kind: "manual", type: "event", url: "", enabled: true, fallback_link: "https://voltaeffect.com/events" };
      const r = await new ManualEventsFetcher().fetch(source, { config: cfg(), clock, storage });
      expect(r.items.map((i) => i.title).sort()).toEqual(["Coming in October", "Held in September", "In November"]);
      // Still filed correctly: only September has been and gone.
      expect(r.items.filter((i) => i.event_timing === "past").map((i) => i.title)).toEqual(["Held in September"]);
    } finally {
      storage.close();
    }
  });
});

describe("news, monthly", () => {
  it("covers the whole previous month, not the last seven days", async () => {
    const item = (title: string, date: string) => `<item><title>${title}</title><link>https://news.test/${encodeURIComponent(title)}</link><pubDate>${date}</pubDate><description>${title} for founders in Halifax, more than the title says.</description></item>`;
    const body = `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
      ${item("Volta early September", "Thu, 03 Sep 2026 12:00:00 GMT")}
      ${item("Volta late September", "Mon, 28 Sep 2026 12:00:00 GMT")}
      ${item("Volta in August", "Sun, 30 Aug 2026 12:00:00 GMT")}
      </channel></rss>`;
    const source: SourceConfig = { id: "news", kind: "rss", type: "news", url: "https://news.test/rss", enabled: true };
    const monthly = await new RssFetcher().fetch(source, { config: cfg(), clock, fetchText: async () => body });
    expect(monthly.items.map((i) => i.title)).toEqual(["Volta early September", "Volta late September"]);
    const weekly = await new RssFetcher().fetch(source, { config: cfg("weekly"), clock, fetchText: async () => body });
    expect(weekly.items.map((i) => i.title)).toEqual(["Volta late September"]);
  });
});

describe("LinkedIn, monthly", () => {
  const source: SourceConfig = { id: "volta-linkedin", kind: "linkedin_company", type: "linkedin", url: "https://li.test/company", enabled: true };
  const page = (posts: Array<{ id: string; date: string }>) => `<html><head><script type="application/ld+json">${JSON.stringify({
    "@graph": posts.map((p) => ({ "@type": "DiscussionForumPosting", datePublished: p.date, url: `https://www.linkedin.com/posts/voltaeffect_post-activity-${p.id}-x`, text: `Volta post ${p.id}.` })),
  })}</script></head></html>`;

  it("keeps the previous month's posts", async () => {
    const html = page([{ id: "7500000000000000001", date: "2026-09-04T12:00:00Z" }, { id: "7500000000000000002", date: "2026-08-25T12:00:00Z" }]);
    const r = await new LinkedInCompanyFetcher().fetch(source, { config: cfg(), clock, fetchText: async () => html });
    expect(r.items).toHaveLength(1);
    expect(r.warnings.join()).not.toMatch(/only reached back/);
  });

  it("warns when the public page does not reach back to the start of the window", async () => {
    const html = page([{ id: "7500000000000000003", date: "2026-09-20T12:00:00Z" }, { id: "7500000000000000004", date: "2026-09-25T12:00:00Z" }]);
    const r = await new LinkedInCompanyFetcher().fetch(source, { config: cfg(), clock, fetchText: async () => html });
    expect(r.items).toHaveLength(2);
    expect(r.warnings.join()).toMatch(/only reached back to 2026-09-20; posts earlier in the window may be missing/);
  });
});

describe("the Slack channel, monthly", () => {
  const source: SourceConfig = { id: "member-links", kind: "slack_channel", type: "member_social", url: "", enabled: true, channel_id: "C0ABCDEF" };
  const ts = (iso: string) => `${Math.floor(Date.parse(iso) / 1000)}.000100`;
  const msg = (n: number, iso: string) => ({ type: "message", user: "U1", ts: ts(iso), text: `Post ${n} <https://m.test/${n}>` });

  function slack(pages: Array<{ messages: unknown[]; next?: string }>) {
    const calls: Array<Record<string, string>> = [];
    const fn = async (method: string, params: Record<string, string>) => {
      if (method === "users.info") return { ok: true, user: { real_name: "Member" } };
      if (method === "chat.getPermalink") return { ok: true, permalink: `https://volta.slack.com/archives/C0ABCDEF/p${params.message_ts!.replace(".", "")}` };
      calls.push(params);
      const page = pages[Math.min(calls.length - 1, pages.length - 1)]!;
      return { ok: true, messages: page.messages, has_more: Boolean(page.next), ...(page.next ? { response_metadata: { next_cursor: page.next } } : {}) };
    };
    return { fn, calls };
  }

  it("asks for the whole previous month and follows every page", async () => {
    const { fn, calls } = slack([
      { messages: [msg(1, "2026-09-28T12:00:00Z")], next: "c2" },
      { messages: [msg(2, "2026-09-03T12:00:00Z")] },
    ]);
    const r = await new SlackChannelFetcher().fetch(source, { config: cfg(), clock, slackApi: fn, env: { SLACK_BOT_TOKEN: "xoxb-test" } });
    expect(r.items.map((i) => i.link)).toEqual(["https://m.test/1", "https://m.test/2"]);
    expect(calls).toHaveLength(2);
    expect(Number(calls[0]!.oldest)).toBe(Date.parse("2026-09-01T03:00:00Z") / 1000);
    expect(Number(calls[0]!.latest)).toBe(Date.parse("2026-10-01T11:30:00Z") / 1000);
    expect(calls[1]!.cursor).toBe("c2");
    expect(r.warnings.join()).not.toMatch(/could be read/);
  });

  it("stops at five pages and says how many messages it read", async () => {
    const endless = Array.from({ length: 5 }, (_, n) => ({ messages: [msg(n, `2026-09-2${n}T12:00:00Z`)], next: `c${n + 1}` }));
    const { fn, calls } = slack(endless);
    const r = await new SlackChannelFetcher().fetch(source, { config: cfg(), clock, slackApi: fn, env: { SLACK_BOT_TOKEN: "xoxb-test" } });
    expect(calls).toHaveLength(5);
    expect(r.warnings.join()).toMatch(/more messages in the window than could be read; only the most recent 5 were read/);
  });
});
