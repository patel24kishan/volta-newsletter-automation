/**
 * What a source that did not work means, and what Bader can do about it. Constraint 8 is "fail
 * loudly"; these are the words that make loud useful.
 */
import { describe, expect, it } from "vitest";
import type { SourceConfig } from "../src/config.js";
import { droppedCount, explainSourceNote, formatSourceNote, parseSourceNote, remedyFor, sourceLink, worthSaying } from "../src/sources/source-notes.js";

const note = (id: string, status: "ok" | "empty" | "failed" | "skipped", error?: string) => ({ id, status, ...(error ? { error } : {}) });

describe("a run's note about a source", () => {
  it("reads back into its parts", () => {
    expect(parseSourceNote("news-volta: empty")).toEqual({ id: "news-volta", status: "empty" });
    expect(parseSourceNote("member-updates: failed (Slack refused the request: not_in_channel)"))
      .toEqual({ id: "member-updates", status: "failed", error: "Slack refused the request: not_in_channel" });
    // Anything unexpected is still shown rather than swallowed.
    expect(parseSourceNote("something odd")).toEqual({ id: "something odd", status: "failed" });
  });
});

describe("what to do about it", () => {
  it("tells him the bot needs inviting, and what to say after", () => {
    expect(remedyFor(note("s", "failed", "Slack refused the request: not_in_channel"), { periodWord: "month" }))
      .toBe("The bot is not in that channel. Open it, type /invite @Volta Newsletter, then say: refresh this month.");
  });

  it("names the maintainer for the jobs that are theirs", () => {
    expect(remedyFor(note("s", "failed", "SLACK_BOT_TOKEN is not set, so the channel cannot be read"))).toMatch(/^The maintainer has to set SLACK_BOT_TOKEN/);
    expect(remedyFor(note("s", "failed", "Slack refused the request: missing_scope"))).toMatch(/^The maintainer has to give the bot permission/);
    expect(remedyFor(note("s", "failed", "the reader for this source broke: boom"))).toMatch(/tell the maintainer/);
  });

  it("says plainly when there is nothing to do", () => {
    expect(remedyFor(note("s", "failed", "LinkedIn served a login wall instead of the public company page"))).toMatch(/^Nothing to do/);
  });

  it("tells a temporary outage from a dead address", () => {
    expect(remedyFor(note("s", "failed", "GET https://x.test failed: HTTP 503"), { periodWord: "month" })).toMatch(/did not answer.*temporary/);
    expect(remedyFor(note("s", "failed", "GET https://x.test failed: HTTP 404"), { periodWord: "month" })).toMatch(/moved or been taken down/);
  });

  it("reassures him about a quiet source, and hints when a search may be too narrow", () => {
    expect(remedyFor(note("s", "empty"), { kind: "ics" })).toBe("That can be normal for a quiet month.");
    expect(remedyFor(note("s", "empty"), { kind: "google_news" })).toMatch(/search words may be too narrow/);
  });

  it("has nothing to add when the error is not one it knows", () => {
    expect(remedyFor(note("s", "failed", "something nobody has seen before"))).toBeUndefined();
  });
});

describe("the whole sentence he reads", () => {
  it("is what happened, what to do, and where to go", () => {
    expect(explainSourceNote(note("member-updates", "failed", "Slack refused the request: not_in_channel"), {
      name: "Member updates", periodWord: "month", link: "https://slack.com/app_redirect?channel=C0C2H7WAUJX",
    })).toBe("Member updates could not be read. The bot is not in that channel. Open it, type /invite @Volta Newsletter, then say: refresh this month. (https://slack.com/app_redirect?channel=C0C2H7WAUJX)");
  });

  it("uses the source's id when he never named it, and drops the link when there is none", () => {
    // A feed has no search words, so it is never told it has narrow ones (QA found that wording).
    expect(explainSourceNote(note("news-volta", "empty"), { kind: "rss" }))
      .toBe("news-volta found nothing this time. That can be normal for a quiet month.");
    expect(explainSourceNote(note("news-volta", "empty"), { kind: "google_news" }))
      .toContain("the search words may be too narrow");
  });
});

describe("where he goes to deal with a source", () => {
  const src = (o: Partial<SourceConfig>) => o as SourceConfig;

  it("opens a Slack channel without anyone building a message link by hand", () => {
    expect(sourceLink(src({ kind: "slack_channel", channel_id: "C0C2H7WAUJX" }))).toBe("https://slack.com/app_redirect?channel=C0C2H7WAUJX");
    expect(sourceLink(src({ kind: "slack_channel", channel_id: "" }))).toBeUndefined();
  });

  it("is the address for everything read over the web, and the events page for his own events", () => {
    expect(sourceLink(src({ kind: "rss", url: "https://news.test/rss" }))).toBe("https://news.test/rss");
    expect(sourceLink(src({ kind: "google_news", url: "https://news.google.com/rss/search?q=Volta" }))).toBe("https://news.google.com/rss/search?q=Volta");
    expect(sourceLink(src({ kind: "manual", url: "", fallback_link: "https://voltaeffect.com/events" }))).toBe("https://voltaeffect.com/events");
  });
});

describe("a source that answered but gave unusable items", () => {
  it("is worth telling him about", () => {
    // The real case: ten LinkedIn posts with no text reached a live campaign because this warning
    // was recorded against a source the run called "ok", and never shown.
    expect(worthSaying("no JSON-LD posts; fell back to 10 permalink(s) with slug titles")).toBe(true);
    expect(worthSaying("page fetched but no posts found; markup may have changed")).toBe(true);
    expect(worthSaying("3 message link(s) could not be fetched")).toBe(true);
    expect(worthSaying("12 item(s) outside the window (2026-09-01 to 2026-10-01)")).toBe(false);
  });
});

describe("a feed that published plenty and had it all filtered out", () => {
  it("says so, with the count and the way to keep everything, instead of \"a quiet month\"", () => {
    const filtered = { id: "cur_betakit", status: "empty" as const, warnings: ['off-topic (no watchlist term): "Calgary fintech raises"', "40 item(s) dropped as off-topic"] };
    const said = explainSourceNote(filtered, { name: "BetaKit", kind: "rss", keepsWords: "Volta or voltaeffect", periodWord: "month" });
    expect(said).toContain("It published 40 item(s), but none of them mention Volta or voltaeffect.");
    expect(said).toContain("To keep everything it publishes, say: keep everything from BetaKit.");
    expect(said).not.toContain("quiet month");
  });

  it("reads as a sentence when the source has its own keywords", () => {
    const filtered = { id: "cur_x", status: "empty" as const, warnings: ["2 item(s) dropped as off-topic"] };
    const said = explainSourceNote(filtered, { name: "Halifax startups", kind: "rss", keepsWords: "aquaculture or fisheries", periodWord: "month" });
    expect(said).toContain("none of them mention aquaculture or fisheries.");
    expect(said).not.toContain("mention only items"); // the clause used to be spliced in whole
  });

  it("tells the window apart from the filter, so he is not sent after the wrong thing", () => {
    const outside = { id: "news-volta", status: "empty" as const, warnings: ["51 item(s) outside the window (2026-08-01 to 2026-09-23 21:36)"] };
    const said = explainSourceNote(outside, { name: "news-volta", kind: "google_news", periodWord: "month" });
    expect(said).toContain("It published 51 item(s), but they were all outside the dates this month reads (2026-08-01 to 2026-09-23 21:36).");
    expect(said).not.toContain("search words may be too narrow");
  });

  it("keeps a note's warnings through being saved and read back", () => {
    const note = { id: "cur_betakit", status: "empty" as const, warnings: ["40 item(s) dropped as off-topic"] };
    expect(parseSourceNote(formatSourceNote(note))).toEqual(note);
    const failed = { id: "s", status: "failed" as const, error: "GET https://x.test failed: HTTP 503", warnings: ["one", "two"] };
    expect(parseSourceNote(formatSourceNote(failed))).toEqual(failed);
    expect(formatSourceNote({ id: "s", status: "empty" })).toBe("s: empty");
  });

  it("has a remedy for every way a source can fail to be read", () => {
    // QA found these written from memory rather than from the fetchers: check the real strings.
    for (const err of [
      "no <rss><channel> or <feed><entry> element; not an RSS or Atom feed",
      "no <rss><channel> element; not an RSS 2.0 feed",
      "no BEGIN:VCALENDAR; not an iCalendar feed",
      "not parseable as XML: unexpected end",
      "empty response body",
      "no channel_id configured for this Slack source",
      "Slack refused the request: something_new",
      "no storage available to read manually added events",
      "fallback_link must be an http(s) page, since a manually added event may have no link of its own",
    ]) {
      expect(remedyFor({ id: "s", status: "failed", error: err }, { periodWord: "month" }), err).toBeDefined();
    }
  });

  it("counts only a real drop line, so a genuinely quiet source still reads as quiet", () => {
    expect(droppedCount(["12 item(s) outside the window (2026-09-01 to 2026-10-01)"])).toBe(0);
    expect(droppedCount(["40 item(s) dropped as off-topic"])).toBe(40);
  });
});

describe("nothing a developer wrote reaches Bader", () => {
  it("drops the raw error whenever there is something better to say", () => {
    for (const err of [
      "GET https://x.test/feed failed: fetch failed",
      "Slack refused the request: channel_not_found (check channel_id in config, and that the bot can see the channel)",
      "no <rss><channel> or <feed><entry> element; not an RSS or Atom feed",
      "SLACK_BOT_TOKEN is not set, so the channel cannot be read",
    ]) {
      const said = explainSourceNote({ id: "s", status: "failed", error: err }, { name: "A source", periodWord: "month" });
      expect(said, err).not.toContain("GET ");
      expect(said, err).not.toContain("channel_not_found");
      expect(said, err).not.toContain("<rss>");
      expect(said, err).not.toContain("config");
    }
  });

  it("still shows the error when nothing better is known, rather than hiding the failure", () => {
    const said = explainSourceNote({ id: "s", status: "failed", error: "something nobody has seen before" }, { name: "A source" });
    expect(said).toBe("A source could not be read: something nobody has seen before.");
  });

  it("reads as one sentence, never two colons in a row", () => {
    const said = explainSourceNote({ id: "s", status: "failed", error: "GET https://x.test failed: HTTP 503" }, { name: "A source", periodWord: "month" });
    expect(said).not.toMatch(/: then say/);
    expect(said).toContain("Then say: refresh this month.");
  });

  it("calls a dead address a typo rather than an outage", () => {
    expect(remedyFor({ id: "s", status: "failed", error: "GET https://nope.test failed: fetch failed ENOTFOUND nope.test" }, { periodWord: "month" }))
      .toMatch(/probably a typo/);
  });
});
