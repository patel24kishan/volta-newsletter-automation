import { describe, expect, it } from "vitest";
import { rankItems } from "../src/pipeline/rank.js";
import { ExtractiveSummarizer, textBeyondTitle } from "../src/pipeline/summarize.js";
import { sampleItem } from "./helpers.js";

describe("ExtractiveSummarizer", () => {
  const s = new ExtractiveSummarizer();

  it("leaves items that already have a summary alone", () => {
    const it = sampleItem({ summary: "Already here." });
    expect(s.summarize([it])[0]).toEqual(it);
  });

  it("extracts from the excerpt beyond the title, never adding words", () => {
    const it = sampleItem({ title: "Volta opens cohort", summary: "", needs_summary: true, raw_excerpt: "Volta opens cohort (Entrevestor) Twelve companies join the fall cohort. Applications closed in August. More text." });
    const out = s.summarize([it])[0]!;
    expect(out.summary).toBe("Twelve companies join the fall cohort. Applications closed in August.");
    expect(out.needs_summary).toBe(false);
    for (const w of out.summary.split(/\W+/).filter(Boolean)) expect(it.raw_excerpt).toContain(w);
  });

  it("keeps needs_summary when the excerpt is only the title and publisher (Google News shape)", () => {
    const it = sampleItem({ title: "Volta hosts mixer - The Coast", summary: "", needs_summary: true, raw_excerpt: "Volta hosts mixer - The Coast (The Coast) Volta hosts mixer - The Coast The Coast" });
    const out = s.summarize([it])[0]!;
    expect(out).toMatchObject({ summary: "", needs_summary: true });
  });

  it("textBeyondTitle strips title and publisher tag", () => {
    expect(textBeyondTitle("Title here (Pub) Body starts.", "Title here")).toBe("Body starts.");
    expect(textBeyondTitle("Title here Title here Pub", "Title here")).toBe("Pub");
  });
});

describe("rankItems", () => {
  const now = new Date("2026-09-15T12:00:00Z");

  it("puts an imminent event with a summary above an old post without one; nothing is dropped", () => {
    const soon = sampleItem({ type: "event", link: "https://e/1", date: "2026-09-16T21:00:00Z", summary: "Demos.", needs_summary: false });
    const later = sampleItem({ type: "event", link: "https://e/2", date: "2026-09-28T21:00:00Z", summary: "Talk.", needs_summary: false });
    const oldPost = sampleItem({ type: "linkedin", link: "https://l/1", date: "2026-09-09T12:00:00Z", summary: "", needs_summary: true, confidence: "medium" });
    const freshNews = sampleItem({ type: "news", link: "https://n/1", date: "2026-09-15T08:00:00Z", summary: "News.", needs_summary: false, related: [{ source: "x", link: "https://x/1", title: "t" }] });
    const r = rankItems([oldPost, later, soon, freshNews], now);
    expect(r.map((x) => x.item.link)).toEqual(["https://n/1", "https://e/1", "https://e/2", "https://l/1"]);
    expect(r).toHaveLength(4);
    expect(r[0]!.reasons.join()).toMatch(/1 related \+1/);
  });

  it("penalizes items that require review", () => {
    const a = sampleItem({ link: "https://a", requires_review: true });
    const b = sampleItem({ link: "https://b", requires_review: false });
    const r = rankItems([a, b], now);
    expect(r[0]!.item.link).toBe("https://b");
  });
});
