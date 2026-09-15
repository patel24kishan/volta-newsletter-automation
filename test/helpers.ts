import { itemId, type Item } from "../src/schema.js";

export function sampleItem(overrides: Partial<Item> = {}): Item {
  const link = overrides.link ?? "https://example.com/story";
  return {
    id: itemId("google-news", link),
    source: "google-news",
    type: "news",
    date: "2026-09-14T12:00:00Z",
    title: "Volta launches a program",
    summary: "Volta launched a program for founders.",
    needs_summary: false,
    link,
    source_ref: "guid-1",
    confidence: "high",
    requires_review: false,
    raw_excerpt: "Volta launched a program for founders in Halifax.",
    ...overrides,
  };
}
