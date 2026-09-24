/**
 * What Bader says about a source, turned into one that can be stored, and what he is told back.
 */
import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { credentialNote, filterWords, readsWhat, slackChannelId, sourceFromFields, sourceLine } from "../src/mcp/source-tools.js";
import type { CuratorSource } from "../src/storage.js";

const config = { watchlist: ["Volta", "voltaeffect"] } as Pick<Config, "watchlist">;

describe("a Slack channel from whatever he pasted", () => {
  it("takes the id out of a channel link, which is what Copy link gives", () => {
    expect(slackChannelId("https://volta.slack.com/archives/C0C2H7WAUJX")).toEqual({ id: "C0C2H7WAUJX" });
    expect(slackChannelId("https://volta.slack.com/archives/C0C2H7WAUJX/p1695412345")).toEqual({ id: "C0C2H7WAUJX" });
    expect(slackChannelId(" C0C2H7WAUJX ")).toEqual({ id: "C0C2H7WAUJX" });
  });

  it("tells him what to paste when he gives a name instead", () => {
    expect(slackChannelId("#member-updates")).toEqual({ error: expect.stringContaining("Copy link") });
    expect(slackChannelId("#member-updates")).toEqual({ error: expect.stringContaining("#member-updates") });
    expect(slackChannelId("the members channel")).toEqual({ error: expect.stringContaining("right-click the channel") });
  });
});

describe("what he gave, as a source to store", () => {
  it("takes a feed and names it after his words for it", () => {
    const r = sourceFromFields({ kind: "rss", url: "https://entrevestor.test/feed", name: "Entrevestor" }, []);
    expect(r).toEqual({ row: expect.objectContaining({ id: "cur_entrevestor", kind: "rss", type: "news", url: "https://entrevestor.test/feed", enabled: true, filtered: false }) });
  });

  it("keeps a news search's words, and leaves its address to be built later", () => {
    const r = sourceFromFields({ kind: "google_news", terms: ["Volta Halifax"] }, []);
    expect(r).toEqual({ row: expect.objectContaining({ id: "cur_volta-halifax", kind: "google_news", terms: ["Volta Halifax"], url: "" }) });
  });

  it("marks a source as filtered only when he gave keywords, so blank still means the watchlist", () => {
    expect(sourceFromFields({ kind: "rss", url: "https://a.test/f", keywords: ["ocean"] }, [])).toMatchObject({ row: { filtered: true, keywords: ["ocean"] } });
    expect(sourceFromFields({ kind: "rss", url: "https://a.test/f", keywords: [] }, [])).toMatchObject({ row: { filtered: true, keywords: [] } });
    expect(sourceFromFields({ kind: "rss", url: "https://a.test/f" }, [])).toMatchObject({ row: { filtered: false } });
  });

  it("gives a calendar its page to fall back to, for an event with no link of its own", () => {
    expect(sourceFromFields({ kind: "ics", url: "https://partner.test/cal.ics" }, []))
      .toMatchObject({ row: { kind: "ics", type: "event", fallback_link: "https://partner.test/cal.ics" } });
  });

  it("says what is missing, in words he can act on", () => {
    expect(sourceFromFields({ kind: "rss" }, [])).toEqual({ errors: ["a feed needs its full address, starting with https://."] });
    expect(sourceFromFields({ kind: "ics", url: "partner.test/cal" }, [])).toEqual({ errors: ["a calendar needs its full address, starting with https://."] });
    expect(sourceFromFields({ kind: "google_news" }, [])).toEqual({ errors: ["A news search needs the words to search for, such as Volta Halifax."] });
    expect(sourceFromFields({ kind: "slack_channel" }, [])).toEqual({ errors: [expect.stringContaining("Copy link")] });
  });

  it("never repeats an id already in use", () => {
    expect(sourceFromFields({ kind: "rss", url: "https://entrevestor.test/feed", name: "Entrevestor" }, ["cur_entrevestor"]))
      .toMatchObject({ row: { id: "cur_entrevestor-2" } });
  });
});

describe("what he is told about a source", () => {
  const row = (o: Partial<CuratorSource> = {}): CuratorSource => ({
    id: "cur_entrevestor", kind: "rss", type: "news", url: "https://entrevestor.test/feed", terms: [], channel_id: "",
    fallback_link: "", keywords: [], filtered: false, label: "Entrevestor", enabled: true, added_at: "2026-09-23T12:00:00.000Z", ...o,
  });

  it("says what it reads, in its own terms", () => {
    expect(readsWhat(row())).toBe("https://entrevestor.test/feed");
    expect(readsWhat(row({ kind: "google_news", url: "", terms: ["Volta Halifax", "Volta Effect"] }))).toBe("a news search for Volta Halifax or Volta Effect");
    expect(readsWhat(row({ kind: "slack_channel", url: "", channel_id: "C0C2H7WAUJX" }))).toBe("the Slack channel C0C2H7WAUJX");
  });

  it("says how it filters, without naming a setting", () => {
    expect(filterWords(row(), config)).toBe("the newsletter's watchlist (Volta, voltaeffect)");
    expect(filterWords(row({ filtered: true, keywords: ["ocean", "tech"] }), config)).toBe("only items mentioning ocean or tech");
    expect(filterWords(row({ filtered: true, keywords: [] }), config)).toBe("everything it publishes");
  });

  it("says what a Slack channel still needs, and whose job it is", () => {
    expect(credentialNote("slack_channel", {})).toContain("SLACK_BOT_TOKEN is not set");
    expect(credentialNote("slack_channel", {})).toContain("only the maintainer can do");
    expect(credentialNote("slack_channel", { SLACK_BOT_TOKEN: "x" })).toContain("/invite @Volta Newsletter");
    expect(credentialNote("linkedin_company", {})).toContain("sign-in page");
    expect(credentialNote("rss", {})).toBeUndefined();
  });

  it("lists one line per source, saying who set it up", () => {
    const his = sourceLine({ source: { id: "cur_entrevestor", kind: "rss", enabled: true }, mine: row(), config, lastRun: "ok" });
    expect(his).toContain("Entrevestor (a feed): https://entrevestor.test/feed");
    expect(his).toContain("on · added by you on 2026-09-23 · keeps the newsletter's watchlist (Volta, voltaeffect) · last run: ok");
    expect(his).toContain("id: cur_entrevestor");

    const theirs = sourceLine({ source: { id: "news-volta", kind: "google_news", enabled: true, terms: ["Volta Halifax"] } as never, config });
    expect(theirs).toContain("news-volta (a news search): a news search for Volta Halifax");
    expect(theirs).toContain("set up by the maintainer");
  });
});
