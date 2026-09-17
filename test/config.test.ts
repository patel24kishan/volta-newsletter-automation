import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, validateConfig } from "../src/config.js";

describe("demo/config.json", () => {
  it("loads and has the live demo sources enabled: news searches, the calendar and LinkedIn", async () => {
    const c = await loadConfig("demo/config.json");
    expect(c.timezone).toBe("America/Halifax");
    expect(c.sources.filter((s) => s.enabled).map((s) => s.id)).toEqual([
      "news-volta",
      "news-volta-effect",
      "news-volta-labs",
      "volta-calendar",
      "volta-linkedin",
    ]);
  });

  it("every news source is a keyword search whose URL is built from its terms", async () => {
    const c = await loadConfig("demo/config.json");
    const news = c.sources.filter((s) => s.kind === "google_news");
    expect(news.length).toBeGreaterThanOrEqual(3);
    for (const s of news) {
      expect(s.terms, s.id).toBeDefined();
      expect(s.terms!.length, s.id).toBeGreaterThan(0);
      expect(new URL(s.url).host, s.id).toBe("news.google.com");
      // One search per source: Google News collapses results when many terms are OR'd together.
      expect(new URL(s.url).searchParams.get("q"), s.id).not.toContain(" OR ");
    }
  });
});

describe("validateConfig", () => {
  const base = {
    timezone: "America/Halifax",
    send_day: "monday",
    reminder_time: "08:30",
    content_window_days: 7,
    events_window_days: 14,
    watchlist: ["Volta"],
    holiday_overrides: ["2026-12-24"],
    alert_recipients: ["bader"],
    sources: [{ id: "a", kind: "rss", type: "news", url: "https://x/feed", enabled: true }],
  };

  it("accepts a valid config", () => {
    expect(validateConfig(base).send_day).toBe("monday");
  });

  it("names every problem in one error", () => {
    expect(() => validateConfig({ ...base, reminder_time: "8am", sources: [] })).toThrow(/reminder_time.*sources|sources.*reminder_time/);
  });

  it("rejects duplicate source ids", () => {
    const dup = { ...base, sources: [base.sources[0], base.sources[0]] };
    expect(() => validateConfig(dup)).toThrow(ConfigError);
  });

  it("rejects non-http source urls", () => {
    const bad = { ...base, sources: [{ ...base.sources[0], url: "file:///x" }] };
    expect(() => validateConfig(bad)).toThrow(/http/);
  });

  it("rejects malformed holiday overrides", () => {
    expect(() => validateConfig({ ...base, holiday_overrides: ["24/12/2026"] })).toThrow(/YYYY-MM-DD/);
  });
});
