import { describe, expect, it } from "vitest";
import { validateConfig, type Config } from "../src/config.js";
import { googleNewsUrl } from "../src/sources/google-news.js";

describe("googleNewsUrl", () => {
  it("groups multi-word terms with parentheses, not quotes, and ORs them together", () => {
    const url = new URL(googleNewsUrl(["Volta Halifax", "Entrevestor", "Wordsworth Gifting"]));
    expect(url.origin + url.pathname).toBe("https://news.google.com/rss/search");
    // Parentheses mean "all these words"; quotes would demand an adjacent phrase and, measured
    // against the live feed, cut 49 stories down to 3.
    expect(url.searchParams.get("q")).toBe("(Volta Halifax) OR Entrevestor OR (Wordsworth Gifting)");
  });

  it("passes a term through untouched when the maintainer wrote their own quotes or parentheses", () => {
    expect(new URL(googleNewsUrl(['"Volta Labs"', "Volta Halifax"])).searchParams.get("q")).toBe('"Volta Labs" OR (Volta Halifax)');
    expect(new URL(googleNewsUrl(["(Volta OR Voltaeffect)"])).searchParams.get("q")).toBe("(Volta OR Voltaeffect)");
  });

  it("defaults to the Canadian English edition and encodes the query safely", () => {
    const url = new URL(googleNewsUrl(["Volta & friends"]));
    expect(url.searchParams.get("hl")).toBe("en-CA");
    expect(url.searchParams.get("gl")).toBe("CA");
    expect(url.searchParams.get("ceid")).toBe("CA:en");
    // The raw query string must be escaped, but decode back to exactly what we asked for.
    expect(url.search).toContain("%26");
    expect(url.searchParams.get("q")).toBe("(Volta & friends)");
  });

  it("accepts another edition", () => {
    const url = new URL(googleNewsUrl(["Volta"], { hl: "en-US", gl: "US" }));
    expect(url.searchParams.get("ceid")).toBe("US:en");
  });

  it("ignores blank terms and refuses an empty list", () => {
    expect(new URL(googleNewsUrl(["  ", "Volta", ""])).searchParams.get("q")).toBe("Volta");
    expect(() => googleNewsUrl([])).toThrow(/at least one search term/);
    expect(() => googleNewsUrl(["   "])).toThrow(/at least one search term/);
  });
});

describe("google_news source config", () => {
  const base = {
    timezone: "America/Halifax", send_day: "monday", reminder_time: "08:30",
    content_window_days: 7, events_window_days: 14, watchlist: ["Volta"],
    holiday_overrides: [], alert_recipients: ["bader"],
  };

  it("builds the feed URL from terms, so the maintainer never edits an encoded query", () => {
    const c: Config = validateConfig({
      ...base,
      sources: [{ id: "google-news", kind: "google_news", type: "news", url: "", enabled: true, terms: ["Volta Halifax", "Entrevestor"] }],
    });
    const built = new URL(c.sources[0]!.url);
    expect(built.searchParams.get("q")).toBe("(Volta Halifax) OR Entrevestor");
  });

  it("adding a keyword changes only the query, nothing else", () => {
    const mk = (terms: string[]) => new URL(validateConfig({ ...base, sources: [{ id: "n", kind: "google_news", type: "news", url: "", enabled: true, terms }] }).sources[0]!.url);
    const before = mk(["Volta Halifax"]);
    const after = mk(["Volta Halifax", "Wordsworth Gifting"]);
    expect(after.searchParams.get("q")).toBe("(Volta Halifax) OR (Wordsworth Gifting)");
    expect(after.pathname).toBe(before.pathname);
    expect(after.searchParams.get("ceid")).toBe(before.searchParams.get("ceid"));
  });

  it("names the problem when terms are missing or empty", () => {
    for (const terms of [undefined, [], ["  "], "Volta"]) {
      expect(() => validateConfig({ ...base, sources: [{ id: "n", kind: "google_news", type: "news", url: "", enabled: true, ...(terms === undefined ? {} : { terms }) }] }), JSON.stringify(terms)).toThrow(/terms must be a non-empty array/);
    }
  });

  it("a plain rss source still requires a real URL and ignores terms", () => {
    expect(() => validateConfig({ ...base, sources: [{ id: "n", kind: "rss", type: "news", url: "", enabled: true }] })).toThrow(/url must be http/);
    const c = validateConfig({ ...base, sources: [{ id: "n", kind: "rss", type: "news", url: "https://feed.test/rss", enabled: true }] });
    expect(c.sources[0]!.url).toBe("https://feed.test/rss");
  });
});
