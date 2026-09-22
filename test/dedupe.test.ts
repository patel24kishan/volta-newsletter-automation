import { describe, expect, it } from "vitest";
import { dedupeItems, mentionsEvent, normalizeUrl, similarTitle } from "../src/pipeline/dedupe.js";
import { validateItem } from "../src/schema.js";
import { sampleItem } from "./helpers.js";

const TZ = "America/Halifax";

describe("normalizeUrl", () => {
  it("strips tracking params, hash, trailing slash and www", () => {
    expect(normalizeUrl("https://www.Example.com/a/?utm_source=x&id=2#top")).toBe("https://example.com/a?id=2");
    expect(normalizeUrl("https://example.com/a/")).toBe("https://example.com/a");
    expect(normalizeUrl("not a url ")).toBe("not a url");
  });
});

describe("similarTitle", () => {
  it("matches the same story titled by two outlets, not two different stories", () => {
    const a = sampleItem({ title: "Volta launches new AI-focused program - Entrevestor" });
    const b = sampleItem({ title: "Volta Launches New AI Focused Program | BetaKit" });
    const c = sampleItem({ title: "Volta moves to new office beside City Hall" });
    expect(similarTitle(a, b)).toBe(true);
    expect(similarTitle(a, c)).toBe(false);
    expect(similarTitle(sampleItem({ title: "Yoga" }), sampleItem({ title: "Yoga" }))).toBe(false); // too short to trust
  });
});

describe("mentionsEvent", () => {
  const yoga = sampleItem({ type: "event", source: "volta-calendar", link: "https://eventbrite.ca/e/yoga", title: "Yoga", date: "2026-09-24T15:00:00Z" });
  it("links a post that names the event and its date", () => {
    const post = sampleItem({ type: "linkedin", source: "volta-linkedin", link: "https://linkedin.com/posts/1", title: "Will we see you next Thursday?", raw_excerpt: "On September 24, join us for a 1-hour guided yoga session." });
    expect(mentionsEvent(yoga, post, TZ)).toBe(true);
    expect(mentionsEvent(yoga, sampleItem({ type: "linkedin", raw_excerpt: "Join us for yoga on Sept 24th!" }), TZ)).toBe(true);
  });
  it("does not link when the date or the title is missing", () => {
    expect(mentionsEvent(yoga, sampleItem({ type: "linkedin", raw_excerpt: "Yoga is great in October." }), TZ)).toBe(false);
    expect(mentionsEvent(yoga, sampleItem({ type: "linkedin", raw_excerpt: "Join us September 24 for a mixer." }), TZ)).toBe(false);
    expect(mentionsEvent(yoga, sampleItem({ type: "event", raw_excerpt: "yoga September 24" }), TZ)).toBe(false);
  });
});

describe("dedupeItems", () => {
  it("folds same-link and same-title items, keeping every link as related, preferring news over linkedin", () => {
    const news = sampleItem({ source: "google-news", type: "news", link: "https://news.test/story?utm_source=a", title: "Volta launches new AI-focused program", summary: "", needs_summary: true });
    const post = sampleItem({ source: "volta-linkedin", type: "linkedin", link: "https://linkedin.com/posts/x", title: "Volta launches new AI focused program!", summary: "We launched a program.", raw_excerpt: "We launched a program. Details inside." });
    const same = sampleItem({ source: "other", type: "news", link: "https://news.test/story/", title: "Different headline entirely", summary: "", needs_summary: true });
    const r = dedupeItems([post, news, same], TZ);
    expect(r.items).toHaveLength(1);
    const s = r.items[0]!;
    expect(s.source).toBe("google-news");
    expect(s.related!.map((x) => x.link).sort()).toEqual(["https://linkedin.com/posts/x", "https://news.test/story/"]);
    expect(s.summary).toBe("We launched a program."); // borrowed from the duplicate
    expect(s.needs_summary).toBe(false);
    expect(s.raw_excerpt).toMatch(/Details inside/);
    expect(validateItem(s).ok).toBe(true);
    expect(r.merges).toHaveLength(2);
  });

  it("keeps the link to the member's Slack message when their share is folded into the same story", () => {
    const news = sampleItem({ source: "google-news", type: "news", link: "https://news.test/story", title: "Volta launches new AI-focused program" });
    const shared = sampleItem({ source: "member-links", type: "member_social", link: "https://news.test/story", title: "Look at this", message_link: "https://volta.slack.com/archives/C1/p1" });
    const r = dedupeItems([shared, news], TZ);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.source).toBe("google-news");
    expect(r.items[0]!.message_link).toBe("https://volta.slack.com/archives/C1/p1");
  });

  it("attaches the yoga post to the yoga event; the event survives", () => {
    const yoga = sampleItem({ type: "event", source: "volta-calendar", link: "https://eventbrite.ca/e/yoga", title: "Yoga", date: "2026-09-24T15:00:00Z", raw_excerpt: "Yoga Join us for a 1-hour guided yoga session." });
    const post = sampleItem({ type: "linkedin", source: "volta-linkedin", link: "https://linkedin.com/posts/y", title: "Will we see you next Thursday?", date: "2026-09-15T16:00:00Z", raw_excerpt: "On September 24, join us for a 1-hour guided yoga session with Jaimee." });
    const other = sampleItem({ type: "linkedin", source: "volta-linkedin", link: "https://linkedin.com/posts/z", title: "Pull up a chair", raw_excerpt: "Co-work day October 1." });
    const r = dedupeItems([post, yoga, other], TZ);
    expect(r.items.map((i) => i.title)).toEqual(["Yoga", "Pull up a chair"]);
    expect(r.items[0]!.related).toEqual([{ source: "volta-linkedin", link: "https://linkedin.com/posts/y", title: "Will we see you next Thursday?" }]);
  });

  it("leaves unrelated items untouched and does not mutate the input", () => {
    const a = sampleItem({ link: "https://a.test/1", title: "Alpha beta gamma" });
    const b = sampleItem({ link: "https://a.test/2", title: "Delta epsilon zeta" });
    const r = dedupeItems([a, b], TZ);
    expect(r.items).toHaveLength(2);
    expect(r.items.every((i) => i.related === undefined)).toBe(true);
    expect(a.related).toBeUndefined();
  });
});
