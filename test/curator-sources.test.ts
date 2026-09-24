/**
 * Sources the curator adds himself: how a stored row becomes a source the fetchers understand,
 * how it is merged with the maintainer's config, and how ids are made.
 */
import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { curatorSourceId, describeSources, effectiveSources, toSourceConfig } from "../src/sources/curator-sources.js";
import { SqliteStorage, type CuratorSource, type NewCuratorSource } from "../src/storage.js";

const config = {
  sources: [
    { id: "news-volta", kind: "rss", type: "news", url: "https://news.test/rss", enabled: true },
    { id: "manual-events", kind: "manual", type: "event", url: "", enabled: true, fallback_link: "https://voltaeffect.com/events" },
  ],
} as unknown as Pick<Config, "sources">;

function row(o: Partial<NewCuratorSource> = {}): CuratorSource {
  return {
    id: "cur_entrevestor", kind: "rss", type: "news", url: "https://entrevestor.test/feed", terms: [], channel_id: "",
    fallback_link: "", keywords: [], filtered: false, label: "Entrevestor", enabled: true, added_at: "2026-09-23T12:00:00.000Z", ...o,
  };
}

describe("a stored source as the fetchers see it", () => {
  it("becomes an ordinary source, and a news search has its address built from its words", () => {
    const feed = toSourceConfig(row());
    expect(feed).toEqual({ source: { id: "cur_entrevestor", kind: "rss", type: "news", url: "https://entrevestor.test/feed", enabled: true } });

    const search = toSourceConfig(row({ id: "cur_search", kind: "google_news", url: "", terms: ["Halifax startups"] }));
    expect("source" in search && search.source.url).toContain("news.google.com/rss/search");
    expect("source" in search && search.source.url).toContain("Halifax+startups");
  });

  it("carries its own keywords only when the curator gave some, so blank still means the watchlist", () => {
    expect(toSourceConfig(row({ keywords: ["oceans"], filtered: true }))).toMatchObject({ source: { keywords: ["oceans"] } });
    // Filtered with none given is his "keep everything from this feed".
    expect(toSourceConfig(row({ keywords: [], filtered: true }))).toMatchObject({ source: { keywords: [] } });
    expect("source" in toSourceConfig(row()) && "keywords" in (toSourceConfig(row()) as { source: object }).source).toBe(false);
  });

  it("is refused, with the config file's own words, when the row cannot make a real source", () => {
    expect(toSourceConfig(row({ url: "news.test/feed" }))).toEqual({ errors: ["source cur_entrevestor.url must be http(s)"] });
    expect(toSourceConfig(row({ kind: "slack_channel", url: "", channel_id: "nope" })))
      .toEqual({ errors: ["source cur_entrevestor.channel_id must be a Slack channel id such as C0123ABCD for a slack_channel source"] });
  });
});

describe("the one list every run reads", () => {
  it("is the config's sources, then the curator's", () => {
    const storage = new SqliteStorage(":memory:");
    try {
      storage.addCuratorSource(row());
      expect(effectiveSources(config, storage).map((s) => s.id)).toEqual(["news-volta", "manual-events", "cur_entrevestor"]);
      // Without storage (a plain fetch, a test), the config alone.
      expect(effectiveSources(config).map((s) => s.id)).toEqual(["news-volta", "manual-events"]);
    } finally {
      storage.close();
    }
  });

  it("lets the maintainer's source win a clash of ids, and reports a broken row instead of throwing", () => {
    const storage = new SqliteStorage(":memory:");
    try {
      storage.addCuratorSource(row({ id: "news-volta", url: "https://other.test/feed" }));
      storage.addCuratorSource(row({ id: "cur_broken", url: "not-a-url" }));
      storage.addCuratorSource(row({ id: "cur_good" }));
      const d = describeSources(config, storage);
      expect(d.sources.map((s) => s.id)).toEqual(["news-volta", "manual-events", "cur_good"]);
      expect(d.sources.find((s) => s.id === "news-volta")!.url).toBe("https://news.test/rss");
      expect(d.shadowed).toEqual(["news-volta"]);
      expect(d.broken).toEqual([{ id: "cur_broken", errors: ["source cur_broken.url must be http(s)"] }]);
    } finally {
      storage.close();
    }
  });
});

describe("the id a new source gets", () => {
  it("is made from his name for it, its address or its first search word, and never repeats", () => {
    expect(curatorSourceId({ label: "Entrevestor Daily" }, [])).toBe("cur_entrevestor-daily");
    expect(curatorSourceId({ url: "https://www.entrevestor.com/feed" }, [])).toBe("cur_entrevestor-com");
    expect(curatorSourceId({ terms: ["Halifax startups"] }, [])).toBe("cur_halifax-startups");
    expect(curatorSourceId({ channel_id: "C0C2H7WAUJX" }, [])).toBe("cur_c0c2h7waujx");
    expect(curatorSourceId({}, [])).toBe("cur_source");
    expect(curatorSourceId({ label: "Entrevestor" }, ["cur_entrevestor", "cur_entrevestor-2"])).toBe("cur_entrevestor-3");
    // Punctuation and emoji cannot reach the id, which items and saved edits are keyed by.
    expect(curatorSourceId({ label: "Ocean & Tech 🌊 news!" }, [])).toBe("cur_ocean-tech-news");
  });
});
