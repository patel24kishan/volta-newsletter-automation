import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { resolveClock } from "../src/clock.js";
import type { Config, SourceConfig } from "../src/config.js";
import {
  LinkedInCompanyFetcher, activityIdFromUrl, activityIdToDate, looksLikeLoginWall, parseJsonLdPosts, parsePermalinkPosts, titleFromSlug,
} from "../src/fetchers/linkedin.js";
import { validateItem } from "../src/schema.js";

const source: SourceConfig = { id: "volta-linkedin", kind: "linkedin_company", type: "linkedin", url: "https://www.linkedin.com/company/voltaeffect/", enabled: true };

function cfg(overrides: Partial<Config> = {}): Config {
  return {
    timezone: "America/Halifax", draft_layout: "events-first", send_day: "monday", reminder_time: "08:30", content_window_days: 7, events_window_days: 14,
    watchlist: ["Volta"], holiday_overrides: [], alert_recipients: [], sources: [source], ...overrides,
  };
}

const P1 = "https://www.linkedin.com/posts/voltaeffect_will-we-see-you-next-thursday-on-activity-7505656961221419008-qsNs";
const P2 = "https://www.linkedin.com/posts/voltaeffect_pull-up-a-chair-and-stay-awhile-coffee-activity-7505581318064283648-lFuD";
const OLD = "https://www.linkedin.com/posts/voltaeffect_old-news-activity-7480000000000000000-zzzz";

function pageWithJsonLd(posts: { url: string; date: string; text: string }[]): string {
  const graph = posts.map((p) => ({
    "@context": "http://schema.org", "@type": "DiscussionForumPosting",
    author: { "@type": "Organization", name: "Volta", url: "https://ca.linkedin.com/company/voltaeffect" },
    datePublished: p.date, mainEntityOfPage: p.url, text: p.text, url: p.url,
  }));
  return `<html><head><script type="application/ld+json">${JSON.stringify({ "@context": "http://schema.org", "@graph": [{ "@type": "Organization", name: "Volta" }, ...graph] })}</script></head><body>${posts.map((p) => `<a href="${p.url}">x</a>`).join("")}</body></html>`;
}

const clock = resolveClock(["--now=2026-09-15T18:00:00Z"], {});
const fetcher = new LinkedInCompanyFetcher();

describe("LinkedIn primitives", () => {
  it("extracts the activity id from a permalink and dates it from the id", () => {
    expect(activityIdFromUrl(P1)).toBe("7505656961221419008");
    // JSON-LD on the live page says this post was published 2026-09-15T16:01:07Z; the id agrees to the second.
    const d = activityIdToDate("7505656961221419008");
    expect(Math.abs(d.getTime() - Date.parse("2026-09-15T16:01:07Z"))).toBeLessThan(2000);
  });

  it("builds a readable title from the slug", () => {
    expect(titleFromSlug(P2)).toBe("Pull up a chair and stay awhile coffee");
    expect(titleFromSlug("https://www.linkedin.com/posts/x_-activity-1-a")).toBe("LinkedIn post");
  });

  it("parses JSON-LD posts and falls back to permalinks", () => {
    const html = pageWithJsonLd([{ url: P1, date: "2026-09-15T16:01:07Z", text: "Will we see you next Thursday?" }]);
    expect(parseJsonLdPosts(html)).toMatchObject([{ url: P1, activityId: "7505656961221419008", via: "jsonld", author: "Volta" }]);
    expect(parsePermalinkPosts(`<a href="${P1}">a</a><a href="${P1}?x=1">dup</a><a href="${P2}">b</a>`)).toHaveLength(2);
  });

  it("recognizes a login wall and not a normal page", () => {
    expect(looksLikeLoginWall('<html><a href="https://www.linkedin.com/authwall?trk=x">Sign in</a></html>')).toBe(true);
    expect(looksLikeLoginWall("<html><h1>Sign in to view more</h1></html>")).toBe(true);
    expect(looksLikeLoginWall(pageWithJsonLd([]))).toBe(false);
  });
});

describe("LinkedInCompanyFetcher on synthetic pages", () => {
  it("emits valid, high-confidence items from JSON-LD, newest first, inside the window", async () => {
    const html = pageWithJsonLd([
      { url: P2, date: "2026-09-15T11:00:33Z", text: "Pull up a chair and stay awhile. Coffee, Community & Co-Work is back on October 1. Register here." },
      { url: P1, date: "2026-09-15T16:01:07Z", text: "Will we see you next Thursday? On September 24, join us for yoga." },
      { url: OLD, date: "2026-07-01T00:00:00Z", text: "Old post." },
    ]);
    const r = await fetcher.fetch(source, { config: cfg(), clock, fetchText: async () => html });
    expect(r.error).toBeUndefined();
    expect(r.items.map((i) => i.link)).toEqual([P1, P2]);
    for (const i of r.items) expect(validateItem(i)).toEqual({ ok: true, errors: [] });
    expect(r.items[1]).toMatchObject({
      title: "Pull up a chair and stay awhile.",
      summary: "Pull up a chair and stay awhile. Coffee, Community & Co-Work is back on October 1.",
      needs_summary: false, confidence: "high", source_ref: "activity:7505581318064283648", type: "linkedin",
    });
    expect(r.warnings.join()).toMatch(/1 post\(s\) outside/);
  });

  it("falls back to permalinks with slug titles, activity-id dates, medium confidence and needs_summary", async () => {
    const html = `<html><body><a href="${P1}">p</a><a href="${OLD}">o</a></body></html>`;
    const r = await fetcher.fetch(source, { config: cfg(), clock, fetchText: async () => html });
    expect(r.error).toBeUndefined();
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ link: P1, title: "Will we see you next thursday on", needs_summary: true, confidence: "medium" });
    expect(r.items[0]!.date.slice(0, 16)).toBe("2026-09-15T16:01");
    expect(r.warnings.join()).toMatch(/fell back/);
  });

  it("reports a login wall as an error, not an empty success (constraint 8)", async () => {
    const r = await fetcher.fetch(source, { config: cfg(), clock, fetchText: async () => '<html><a href="/authwall?trk=bf">Sign in</a></html>' });
    expect(r.error).toMatch(/login wall/);
    expect(r.items).toHaveLength(0);
  });

  it("reports an HTTP 999 bot block as an error", async () => {
    const r = await fetcher.fetch(source, { config: cfg(), clock, fetchText: async () => { throw new Error("GET https://www.linkedin.com/company/voltaeffect/ returned HTTP 999"); } });
    expect(r.error).toMatch(/HTTP 999/);
  });

  it("a fetched page with no posts and no wall is zero items with a markup warning", async () => {
    const r = await fetcher.fetch(source, { config: cfg(), clock, fetchText: async () => "<html><body><p>About Volta</p></body></html>" });
    expect(r.error).toBeUndefined();
    expect(r.items).toHaveLength(0);
    expect(r.warnings.join()).toMatch(/markup may have changed/);
  });
});

describe("recorded LinkedIn snapshots (test/fixtures)", () => {
  it("volta-linkedin.html yields real posts via JSON-LD, all valid and linked to linkedin.com/posts", async () => {
    const html = await readFile("test/fixtures/volta-linkedin.html", "utf8");
    expect(parseJsonLdPosts(html).length).toBeGreaterThanOrEqual(5);
    const r = await fetcher.fetch(source, { config: cfg(), clock, fetchText: async () => html });
    expect(r.error).toBeUndefined();
    expect(r.items.length).toBeGreaterThanOrEqual(3);
    for (const i of r.items) {
      expect(validateItem(i).ok).toBe(true);
      expect(i.link).toMatch(/^https:\/\/www\.linkedin\.com\/posts\//);
      expect(i.confidence).toBe("high");
      expect(i.needs_summary).toBe(false);
    }
    expect(r.items.some((i) => /yoga/i.test(i.raw_excerpt))).toBe(true);
  });

  it("linkedin-login-wall.html (HTTP 999 body from the /posts/ URL) is detected as a wall", async () => {
    const html = await readFile("test/fixtures/linkedin-login-wall.html", "utf8");
    expect(looksLikeLoginWall(html)).toBe(true);
    const r = await fetcher.fetch(source, { config: cfg(), clock, fetchText: async () => html });
    expect(r.error).toMatch(/login wall/);
  });
});
