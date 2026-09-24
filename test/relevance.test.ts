/**
 * Which words a source keeps its items by: the newsletter's watchlist, or the curator's own words
 * for a source he added.
 */
import { describe, expect, it } from "vitest";
import type { Config, SourceConfig } from "../src/config.js";
import { hasOwnKeywords, keepRelevant, keywordsFor } from "../src/sources/relevance.js";
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
