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
    expect(r.warnings.join("\n")).toMatch(/2 item\(s\) outside the window \(/);
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

  it("uses a curator source's own keywords instead of the watchlist, and says which it dropped by", async () => {
    const body = feed(
      rssItem({ title: "Ottawa funds 40 AI projects", link: "https://a.test/ottawa", date: "Mon, 14 Sep 2026 10:00:00 GMT" }) +
      rssItem({ title: "Ocean tech startup raises seed", link: "https://a.test/ocean", date: "Mon, 14 Sep 2026 10:00:00 GMT" }),
    );
    const own = { ...source, keywords: ["ocean"] };
    const r = await fetcher.fetch(own, { config: cfg(), clock, fetchText: async () => body });
    expect(r.items.map((i) => i.title)).toEqual(["Ocean tech startup raises seed"]);
    expect(r.warnings.join("\n")).toMatch(/off-topic \(no keyword for this source\).*Ottawa/);
  });

  it("keeps everything from a feed the curator asked to keep everything from", async () => {
    const body = feed(
      rssItem({ title: "Ottawa funds 40 AI projects", link: "https://a.test/ottawa", date: "Mon, 14 Sep 2026 10:00:00 GMT" }) +
      rssItem({ title: "Volta hosts mixer", link: "https://a.test/volta", date: "Mon, 14 Sep 2026 10:00:00 GMT" }),
    );
    const r = await fetcher.fetch({ ...source, keywords: [] }, { config: cfg(), clock, fetchText: async () => body });
    expect(r.items).toHaveLength(2);
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

function atomFeed(entries: string, feedTitle = "Halifax"): string {
  return `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>${feedTitle}</title><id>https://a.test/feed</id>${entries}</feed>`;
}

/** Atom carries the URL in an attribute, so links are passed in already built. */
function atomLink(href: string, rel?: string): string {
  return `<link${rel ? ` rel="${rel}"` : ""} href="${href}"/>`;
}

function atomEntry(o: { title: string; titleType?: string; links?: string; id?: string; published?: string; updated?: string; summary?: string; content?: string; src?: string }): string {
  return `<entry><title${o.titleType ? ` type="${o.titleType}"` : ""}>${o.title}</title>${o.links ?? ""}` +
    `${o.id !== undefined ? `<id>${o.id}</id>` : ""}${o.published !== undefined ? `<published>${o.published}</published>` : ""}` +
    `${o.updated !== undefined ? `<updated>${o.updated}</updated>` : ""}${o.summary !== undefined ? `<summary>${o.summary}</summary>` : ""}` +
    `${o.content !== undefined ? `<content type="html">${o.content}</content>` : ""}${o.src ? `<source><title>${o.src}</title></source>` : ""}</entry>`;
}

const sep14 = "2026-09-14T10:00:00+00:00";

describe("RssFetcher on synthetic Atom feeds", () => {
  it("maps an Atom entry into the same Item shape as an RSS item", async () => {
    const body = atomFeed(
      atomEntry({ title: "Volta opens cohort", links: atomLink("https://a.test/1"), id: "t3_abc", published: sep14, summary: "Volta announced a new founder cohort starting in October with twelve companies." }),
    );
    const r = await fetcher.fetch(source, { config: cfg(), clock, fetchText: async () => body });
    expect(r.error).toBeUndefined();
    expect(r.items).toHaveLength(1);
    const it = r.items[0]!;
    expect(validateItem(it)).toEqual({ ok: true, errors: [] });
    expect(it).toMatchObject({ source: "google-news", type: "news", title: "Volta opens cohort", link: "https://a.test/1", source_ref: "t3_abc", needs_summary: false, date: "2026-09-14T10:00:00.000Z" });
    expect(it.summary).toBe("Volta announced a new founder cohort starting in October with twelve companies.");
    // No <source>, so the publisher is the feed's own title.
    expect(it.raw_excerpt).toMatch(/\(Halifax\)/);
  });

  it("prefers <published> over <updated>, <summary> over <content>, and unescapes an html title", async () => {
    const body = atomFeed(
      atomEntry({ title: "Volta opens &lt;em&gt;cohort&lt;/em&gt;", titleType: "html", links: atomLink("https://a.test/1"), updated: sep14, content: "&lt;p&gt;Volta announced a new founder cohort starting in October with twelve companies.&lt;/p&gt;", src: "Entrevestor" }),
    );
    const r = await fetcher.fetch(source, { config: cfg(), clock, fetchText: async () => body });
    const it = r.items[0]!;
    expect(it.title).toBe("Volta opens cohort");
    expect(it.date).toBe("2026-09-14T10:00:00.000Z");
    expect(it.summary).toBe("Volta announced a new founder cohort starting in October with twelve companies.");
    expect(it.raw_excerpt).toMatch(/\(Entrevestor\)/);
  });

  it("takes the alternate link, falls back to a <id> that is a URL, and skips an entry with neither", async () => {
    const body = atomFeed(
      atomEntry({ title: "Volta one", links: atomLink("https://a.test/1.atom", "self") + atomLink("https://a.test/1", "alternate"), id: "t3_a", published: sep14 }) +
      atomEntry({ title: "Volta two", id: "https://a.test/2", published: sep14 }) +
      atomEntry({ title: "Volta three", id: "t3_c", published: sep14 }),
    );
    const r = await fetcher.fetch(source, { config: cfg(), clock, fetchText: async () => body });
    expect(r.items.map((i) => i.link)).toEqual(["https://a.test/1", "https://a.test/2"]);
    expect(r.warnings.filter((w) => w.startsWith("skipped item without title or absolute link"))).toHaveLength(1);
  });

  it("drops Atom entries outside the content window and reports the count", async () => {
    const body = atomFeed(
      atomEntry({ title: "Volta old", links: atomLink("https://a.test/old"), published: "2026-09-01T10:00:00+00:00" }) +
      atomEntry({ title: "Volta now", links: atomLink("https://a.test/now"), published: "2026-09-15T09:00:00+00:00" }),
    );
    const r = await fetcher.fetch(source, { config: cfg(), clock, fetchText: async () => body });
    expect(r.items.map((i) => i.link)).toEqual(["https://a.test/now"]);
    expect(r.warnings.join("\n")).toMatch(/1 item\(s\) outside the window \(/);
  });

  it("applies the watchlist to Atom entries too", async () => {
    const body = atomFeed(
      atomEntry({ title: "Ottawa funds 40 AI projects", links: atomLink("https://a.test/ottawa"), published: sep14 }) +
      atomEntry({ title: "Volta hosts mixer", links: atomLink("https://a.test/volta"), published: sep14 }),
    );
    const r = await fetcher.fetch(source, { config: cfg(), clock, fetchText: async () => body });
    expect(r.items.map((i) => i.title)).toEqual(["Volta hosts mixer"]);
    expect(r.warnings.join("\n")).toMatch(/off-topic.*Ottawa/);
  });

  it("an Atom feed with no entries is zero items with no error", async () => {
    const r = await fetcher.fetch(source, { config: cfg(), clock, fetchText: async () => atomFeed("") });
    expect(r.error).toBeUndefined();
    expect(r.items).toHaveLength(0);
  });

  it("a document that is neither RSS nor Atom fails with a message naming both", async () => {
    const r = await fetcher.fetch(source, { config: cfg(), clock, fetchText: async () => "<html><body>login</body></html>" });
    expect(r.error).toBe("no <rss><channel> or <feed><entry> element; not an RSS or Atom feed");
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

describe("Reddit-shaped Atom snapshot (test/fixtures/halifax-atom.xml)", () => {
  it("parses as Atom and keeps the on-topic posts with their real links", async () => {
    const body = await readFile("test/fixtures/halifax-atom.xml", "utf8");
    const parsed = parseRss(body);
    expect("error" in parsed).toBe(false);
    if ("error" in parsed) return;
    expect(parsed.items).toHaveLength(3);

    // Wide window against the real clock, so the snapshot stays useful as it ages.
    const r = await fetcher.fetch(source, { config: cfg({ content_window_days: 3650 }), clock: resolveClock([], {}), fetchText: async () => body });
    expect(r.error).toBeUndefined();
    expect(r.items.map((i) => i.title)).toEqual(["Volta fall cohort applications open", "Demo night at Volta on Thursday"]);
    for (const it of r.items) {
      expect(validateItem(it).ok).toBe(true);
      expect(it.link).toMatch(/^https:\/\/www\.reddit\.com\/r\/halifax\/comments\//);
    }
    expect(r.items[0]).toMatchObject({ source_ref: "t3_1n8q2xk", date: "2026-09-18T11:22:05.000Z", needs_summary: false });
    expect(r.items[0]!.summary).toMatch(/^Volta is opening applications for its fall founder cohort/);
    expect(r.warnings.join("\n")).toMatch(/off-topic.*Bridge lane closure/);
  });
});
