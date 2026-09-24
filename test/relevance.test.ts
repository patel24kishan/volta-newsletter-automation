/**
 * Which words a source keeps its items by: the newsletter's watchlist, or the curator's own words
 * for a source he added.
 */
import { describe, expect, it } from "vitest";
import type { Config, SourceConfig } from "../src/config.js";
import { mentionsAny } from "../src/text.js";
import { hasOwnKeywords, isLocalEnough, keepRelevant, keywordsFor } from "../src/sources/relevance.js";
import { sampleItem } from "./helpers.js";

const config = { watchlist: ["Volta", "voltaeffect"] } as Pick<Config, "watchlist">;
const source = (keywords?: string[]) => ({ id: "s", ...(keywords ? { keywords } : {}) }) as unknown as SourceConfig;

describe("the words a source filters on", () => {
  it("is the newsletter's watchlist when the source says nothing", () => {
    expect(keywordsFor(source(), config)).toEqual(["Volta", "voltaeffect"]);
    expect(hasOwnKeywords(source())).toBe(false);
  });

  it("is the source's own words when it has them", () => {
    expect(keywordsFor(source(["ocean tech"]), config)).toEqual(["ocean tech"]);
    expect(hasOwnKeywords(source(["ocean tech"]))).toBe(true);
  });

  it("keeps everything when the curator gave an empty list", () => {
    expect(keywordsFor(source([]), config)).toEqual([]);
    expect(hasOwnKeywords(source([]))).toBe(true);
  });
});

describe("filtering a source's items after the fetch", () => {
  const ocean = sampleItem({ link: "https://x.test/a", title: "Ocean tech startup raises seed", summary: "A Halifax ocean tech company." });
  const other = sampleItem({ link: "https://x.test/b", title: "City council debates parking", summary: "Nothing to do with the sector." });

  it("leaves a maintainer's source exactly as it was", () => {
    // The watchlist is applied while reading a feed, never here, so nothing is dropped twice.
    expect(keepRelevant(source(), config, [ocean, other])).toEqual({ items: [ocean, other], dropped: 0 });
  });

  it("keeps only what mentions one of the curator's words, and counts what went", () => {
    const r = keepRelevant(source(["ocean"]), config, [ocean, other]);
    expect(r.items.map((i) => i.title)).toEqual(["Ocean tech startup raises seed"]);
    expect(r.dropped).toBe(1);
  });

  it("keeps everything from a source he asked to keep everything from", () => {
    expect(keepRelevant(source([]), config, [ocean, other]).items).toHaveLength(2);
  });

  it("matches the words a reader sees, not the link", () => {
    const linked = sampleItem({ link: "https://ocean.test/story", title: "Council debates parking", summary: "No sector news." });
    expect(keepRelevant(source(["ocean"]), config, [linked]).items).toEqual([]);
  });
});

describe("news has to be about the right place", () => {
  const cfg = { watchlist: ["Volta", "voltaeffect"], local_terms: ["Halifax", "Nova Scotia"] } as Pick<Config, "watchlist" | "local_terms">;
  const watchlisted = { id: "news-volta" } as unknown as SourceConfig;
  const his = { id: "cur_ocean", keywords: ["ocean"] } as unknown as SourceConfig;

  it("keeps a Halifax story and drops a Ghanaian one, though both say Volta", () => {
    // The real headline that reached a live campaign.
    expect(isLocalEnough(watchlisted, cfg, "Over 1,000 NDC women petition A-G for Sedina's release, Volta youth group backs call")).toBe(false);
    expect(isLocalEnough(watchlisted, cfg, "Volta opens applications for its fall cohort in Halifax")).toBe(true);
    expect(isLocalEnough(watchlisted, cfg, "Volta River Authority announces an outage")).toBe(false);
  });

  it("leaves a source the curator gave his own words alone: he chose them", () => {
    expect(isLocalEnough(his, cfg, "Ocean tech in Vancouver raises a round")).toBe(true);
  });

  it("changes nothing when the config names no places", () => {
    expect(isLocalEnough(watchlisted, { watchlist: ["Volta"] } as Pick<Config, "watchlist" | "local_terms">, "Volta Region, Ghana")).toBe(true);
  });
});

describe("a watchlist word is a word, not a run of letters", () => {
  it("no longer matches voltage or Revolta", () => {
    expect(mentionsAny("High voltage battery plant opens", ["Volta"])).toBe(false);
    expect(mentionsAny("Revolta Motors expands", ["Volta"])).toBe(false);
    expect(mentionsAny("Volta, Halifax hub, opens applications", ["Volta"])).toBe(true);
    expect(mentionsAny("voltaeffect posted an update", ["voltaeffect"])).toBe(true);
  });
});
