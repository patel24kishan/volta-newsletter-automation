/**
 * Summarizer stage. Behind an interface so an LLM adapter can replace it later (back burner).
 * The extractive summarizer never writes words that are not in the item's own retrieved text.
 */
import { firstSentences } from "../text.js";
import type { Item } from "../schema.js";

export interface Summarizer {
  summarize(items: Item[]): Item[];
}

export class ExtractiveSummarizer implements Summarizer {
  constructor(private readonly sentences = 2, private readonly maxChars = 280) {}

  summarize(items: Item[]): Item[] {
    return items.map((it) => {
      if (it.summary !== "") return it;
      const beyondTitle = textBeyondTitle(it.raw_excerpt, it.title);
      const summary = firstSentences(beyondTitle, this.sentences, this.maxChars);
      if (!summary || summary.length < 20) return { ...it, summary: "", needs_summary: true };
      return { ...it, summary, needs_summary: false };
    });
  }
}

/** Drop the title (and a publisher tag like "(Entrevestor)") from the front of the excerpt. */
export function textBeyondTitle(excerpt: string, title: string): string {
  let t = excerpt.trim();
  const lower = t.toLowerCase();
  const tl = title.trim().toLowerCase();
  if (tl && lower.startsWith(tl)) t = t.slice(title.trim().length).trim();
  t = t.replace(/^\([^)]{1,60}\)\s*/, "");
  // Google News repeats "Title Publisher" in the description; if what's left is just the title again, it's empty.
  if (tl && t.toLowerCase().replace(/\s+/g, " ").startsWith(tl)) t = t.slice(title.trim().length).trim();
  return t.replace(/^[-–—:|]+\s*/, "");
}
