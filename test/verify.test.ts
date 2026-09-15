import { describe, expect, it } from "vitest";
import { extractEntities, verifyDraft } from "../src/pipeline/verify.js";
import { sampleItem } from "./helpers.js";

const TZ = "America/Halifax";
const items = [
  sampleItem({
    type: "event", source: "volta-calendar", link: "https://www.eventbrite.ca/e/yoga-1", title: "Yoga",
    date: "2026-09-24T15:00:00Z", // 12:00 pm Halifax
    summary: "Join us for a 1-hour guided yoga session with Jaimee Lee-Baggley.",
    raw_excerpt: "Yoga Location: Volta, Halifax. Join us for a 1-hour guided yoga session with Jaimee Lee-Baggley designed for desk-based lifestyles.",
    location: "Volta, Halifax",
    related: [{ source: "volta-linkedin", link: "https://www.linkedin.com/posts/voltaeffect_yoga-activity-1-a", title: "Will we see you next Thursday?" }],
  }),
  sampleItem({
    type: "news", source: "google-news", link: "https://news.google.com/rss/articles/abc", title: "Volta Launches New AI-Focused Program - Entrevestor",
    date: "2026-03-19T06:57:48Z", summary: "", needs_summary: true,
    raw_excerpt: "Volta Launches New AI-Focused Program - Entrevestor (Entrevestor)",
  }),
];
const allow = ["Upcoming events", "News", "From Volta's LinkedIn", "This week at Volta", "Volta", "LinkedIn"];

describe("verifyDraft", () => {
  it("passes a draft built only from the items", () => {
    const draft = [
      "# This week at Volta",
      "## Upcoming events",
      "**Yoga** on Thursday, September 24 at 12:00 pm, Volta, Halifax. Join us for a 1-hour guided yoga session with Jaimee Lee-Baggley. https://www.eventbrite.ca/e/yoga-1 (also on LinkedIn: https://www.linkedin.com/posts/voltaeffect_yoga-activity-1-a)",
      "## News",
      "Volta Launches New AI-Focused Program - Entrevestor. https://news.google.com/rss/articles/abc",
    ].join("\n");
    const r = verifyDraft(draft, items, { timeZone: TZ, allow });
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.checked.links).toBe(3);
    expect(r.checked.dates).toBe(1);
    expect(r.checked.times).toBe(1);
  });

  it("fails on an invented person, and names them", () => {
    const r = verifyDraft("Yoga on September 24 with instructor Marcus Aurelius Chen. https://www.eventbrite.ca/e/yoga-1", items, { timeZone: TZ, allow });
    expect(r.ok).toBe(false);
    expect(r.violations).toEqual([expect.objectContaining({ kind: "entity", value: "Marcus Aurelius Chen" })]);
  });

  it("fails on a wrong date, a wrong time and a foreign link", () => {
    const r = verifyDraft("Yoga on September 25 at 6:30 pm. Tickets: https://example.com/tickets", items, { timeZone: TZ, allow });
    expect(r.violations.map((v) => v.kind).sort()).toEqual(["date", "link", "time"]);
    expect(r.violations.find((v) => v.kind === "date")!.value).toBe("September 25");
  });

  it("accepts date and time variants that match an item", () => {
    for (const d of ["Sept. 24th", "24 September", "2026-09-24", "September 24, 2026"]) {
      expect(verifyDraft(`Yoga ${d}`, items, { timeZone: TZ, allow }).ok, d).toBe(true);
    }
    expect(verifyDraft("Yoga at 12:00PM", items, { timeZone: TZ, allow }).ok).toBe(true);
    expect(verifyDraft("Yoga September 24, 2025", items, { timeZone: TZ, allow }).ok).toBe(false);
  });

  it("does not flag sentence-initial common words, but does flag mid-sentence unknown names", () => {
    expect(verifyDraft("Join us for yoga. Bring a mat.", items, { timeZone: TZ, allow }).ok).toBe(true);
    const r = verifyDraft("Join us for yoga with Bob.", items, { timeZone: TZ, allow });
    expect(r.violations).toEqual([expect.objectContaining({ kind: "entity", value: "Bob" })]);
  });

  it("accepts related-link URLs and tracking-param variants of item links", () => {
    expect(verifyDraft("https://www.linkedin.com/posts/voltaeffect_yoga-activity-1-a?utm_source=newsletter", items, { timeZone: TZ, allow }).ok).toBe(true);
  });

  it("a draft with an invented event fails even when everything else is real", () => {
    const r = verifyDraft("Yoga on September 24. Also: Founder Pitch Night on September 30 at 7:00 pm.", items, { timeZone: TZ, allow });
    expect(r.violations.map((v) => `${v.kind}:${v.value}`)).toEqual(["date:September 30", "time:7:00 pm", "entity:Founder Pitch Night"]);
  });
});

describe("extractEntities", () => {
  it("returns multi-word phrases and mid-sentence single names", () => {
    const text = "Join Sam Silver and guest Darryl Wright at Volta. Register with Bethany. New program launches.";
    expect(extractEntities(text, []).map((p) => p.value)).toEqual(["Sam Silver", "Darryl Wright", "Volta", "Bethany"]);
  });
});
