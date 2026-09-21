import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { resolveClock } from "../src/clock.js";
import type { Config, SourceConfig } from "../src/config.js";
import { RssFetcher, parseRss } from "../src/fetchers/rss.js";
import { validateItem } from "../src/schema.js";

const source: SourceConfig = { id: "google-news", kind: "rss", type: "news", url: "https://example.test/feed", enabled: true };

function cfg(overrides: Partial<Config> = {}): Config {
  return {
    timezone: "America/Halifax",
    draft_layout: "events-first",
    send_day: "monday",
    reminder_time: "08:30",
    content_window_days: 7,
    events_window_days: 14,
    watchlist: ["Volta"],
    holiday_overrides: [],
    alert_recipients: [],
    sources: [source],
    ...overrides,
  };
}

function feed(items: string): string {
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>${items}</channel></rss>`;
}

function rssItem(o: { title: string; link?: string; date?: string; desc?: string; guid?: string; src?: string }): string {
  return `<item><title>${o.title}</title>${o.link !== undefined ? `<link>${o.link}</link>` : ""}<guid>${o.guid ?? o.link ?? ""}</guid>` +
    `${o.date !== undefined ? `<pubDate>${o.date}</pubDate>` : ""}${o.desc !== undefined ? `<description><![CDATA[${o.desc}]]></description>` : ""}` +
    `${o.src ? `<source url="https://pub.test">${o.src}</source>` : ""}</item>`;
}

const now = "2026-09-15T12:00:00Z";
const clock = resolveClock([`--now=${now}`], {});
const fetcher = new RssFetcher();

describe("RssFetcher on synthetic feeds", () => {
  it("keeps in-window, on-topic items and produces valid schema items", async () => {
    const body = feed(
      rssItem({ title: "Volta opens cohort", link: "https://a.test/1", date: "Mon, 14 Sep 2026 10:00:00 GMT", desc: "Volta announced a new founder cohort starting in October with twelve companies.", src: "Entrevestor" }),
    );
    const r = await fetcher.fetch(source, { config: cfg(), clock, fetchText: async () => body });
    expect(r.error).toBeUndefined();
    expect(r.items).toHaveLength(1);
    const it = r.items[0]!;
    expect(validateItem(it)).toEqual({ ok: true, errors: [] });
    expect(it).toMatchObject({ source: "google-news", type: "news", link: "https://a.test/1", needs_summary: false, date: "2026-09-14T10:00:00.000Z" });
    expect(it.summary).toMatch(/founder cohort/);
    expect(it.raw_excerpt).toMatch(/Entrevestor/);
  });

  it("caps the summary at two sentences even when the description carries a whole article", async () => {
    const article = "Volta announced a new founder cohort. It starts in October. " + "More detail follows here. ".repeat(40);
    const body = feed(rssItem({ title: "Volta opens cohort", link: "https://a.test/1", date: "Mon, 14 Sep 2026 10:00:00 GMT", desc: article }));
    const r = await fetcher.fetch(source, { config: cfg(), clock, fetchText: async () => body });
    expect(r.items[0]!.summary).toBe("Volta announced a new founder cohort. It starts in October.");
    expect(r.items[0]!.raw_excerpt.length).toBeGreaterThan(500);
  });

  it("drops items outside the content window and reports the count", async () => {
    const body = feed(
      rssItem({ title: "Volta old", link: "https://a.test/old", date: "Tue, 01 Sep 2026 10:00:00 GMT" }) +
      rssItem({ title: "Volta future", link: "https://a.test/future", date: "Wed, 16 Sep 2026 10:00:00 GMT" }) +
      rssItem({ title: "Volta now", link: "https://a.test/now", date: "Tue, 15 Sep 2026 09:00:00 GMT" }),
    );
    const r = await fetcher.fetch(source, { config: cfg(), clock, fetchText: async () => body });
    expect(r.items.map((i) => i.link)).toEqual(["https://a.test/now"]);
    expect(r.warnings.join("\n")).toMatch(/2 item\(s\) outside the 7-day window/);
  });

  it("the clock override moves the window", async () => {
    const body = feed(rssItem({ title: "Volta old", link: "https://a.test/old", date: "Tue, 01 Sep 2026 10:00:00 GMT" }));
    const sept3 = resolveClock(["--now=2026-09-03T00:00:00Z"], {});
    const r = await fetcher.fetch(source, { config: cfg(), clock: sept3, fetchText: async () => body });
    expect(r.items).toHaveLength(1);
  });

  it("drops off-topic items (no watchlist term) and names them", async () => {
    const body = feed(
      rssItem({ title: "Ottawa funds 40 AI projects", link: "https://a.test/ottawa", date: "Mon, 14 Sep 2026 10:00:00 GMT" }) +
      rssItem({ title: "Volta hosts mixer", link: "https://a.test/volta", date: "Mon, 14 Sep 2026 10:00:00 GMT" }),
    );
    const r = await fetcher.fetch(source, { config: cfg(), clock, fetchText: async () => body });
    expect(r.items.map((i) => i.title)).toEqual(["Volta hosts mixer"]);
    expect(r.warnings.join("\n")).toMatch(/off-topic.*Ottawa/);
  });

  it("flags needs_summary when the description adds nothing beyond the title", async () => {
    const body = feed(rssItem({ title: "Volta hosts mixer", link: "https://a.test/1", date: "Mon, 14 Sep 2026 10:00:00 GMT", desc: '<a href="https://a.test/1">Volta hosts mixer</a>&nbsp;&nbsp;<font color="#6f6f6f">The Coast</font>' }));
    const r = await fetcher.fetch(source, { config: cfg(), clock, fetchText: async () => body });
    expect(r.items[0]).toMatchObject({ summary: "", needs_summary: true });
  });

  it("skips items with no absolute link or no date, never storing a linkless item (constraint 5)", async () => {
    const body = feed(
      rssItem({ title: "Volta no link", date: "Mon, 14 Sep 2026 10:00:00 GMT" }) +
      rssItem({ title: "Volta relative", link: "/rel", date: "Mon, 14 Sep 2026 10:00:00 GMT" }) +
      rssItem({ title: "Volta no date", link: "https://a.test/nodate" }),
    );
    const r = await fetcher.fetch(source, { config: cfg(), clock, fetchText: async () => body });
    expect(r.items).toHaveLength(0);
    expect(r.warnings.filter((w) => w.startsWith("skipped"))).toHaveLength(3);
  });

  it("reports a fetch failure as error, not as an empty success (constraint 8)", async () => {
    const r = await fetcher.fetch(source, { config: cfg(), clock, fetchText: async () => { throw new Error("GET failed: ECONNRESET"); } });
    expect(r.error).toMatch(/ECONNRESET/);
    expect(r.items).toHaveLength(0);
  });

  it("reports unparseable or non-RSS bodies as error", async () => {
    expect((await fetcher.fetch(source, { config: cfg(), clock, fetchText: async () => "" })).error).toMatch(/empty/);
    expect((await fetcher.fetch(source, { config: cfg(), clock, fetchText: async () => "<html><body>login</body></html>" })).error).toMatch(/not an RSS/);
  });

  it("an empty feed is zero items with no error", async () => {
    const r = await fetcher.fetch(source, { config: cfg(), clock, fetchText: async () => feed("") });
    expect(r.error).toBeUndefined();
    expect(r.items).toHaveLength(0);
  });
});

describe("recorded Google News snapshot (test/fixtures/google-news.xml)", () => {
  it("parses as RSS with items, and every in-window item is schema-valid with a Google News link", async () => {
    const body = await readFile("test/fixtures/google-news.xml", "utf8");
    const parsed = parseRss(body);
    expect("error" in parsed).toBe(false);
    if ("error" in parsed) return;
    expect(parsed.items.length).toBeGreaterThan(0);

    // Use a wide window so the snapshot stays useful as it ages.
    const r = await fetcher.fetch(source, { config: cfg({ content_window_days: 3650 }), clock: resolveClock([], {}), fetchText: async () => body });
    expect(r.error).toBeUndefined();
    expect(r.items.length).toBeGreaterThan(0);
    for (const it of r.items) {
      expect(validateItem(it).ok).toBe(true);
      expect(it.link).toMatch(/^https:\/\/news\.google\.com\//);
    }
  });
});
