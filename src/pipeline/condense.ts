/**
 * Condense a write-up's points into a short entry for the newsletter.
 *
 * There is no LLM (back burner), so this selects rather than rewrites: it breaks the points into
 * sentences, scores each one, and keeps the best few within a word budget. Every word it outputs
 * is a sentence the source wrote, so the no-fabrication rule still holds by construction.
 *
 * What makes a sentence worth keeping, in order of weight:
 *   - it carries a figure ("18% empty miles", "$1.4M", "14-month")     concrete beats general
 *   - it opens its bullet                                               the writer's own lead
 *   - it comes from an early bullet                                     write-ups lead with the news
 * and what counts against it:
 *   - it judges the material rather than reporting it ("the tension is the story")
 *   - it starts with a pronoun, so it reads badly once lifted out of its paragraph
 *   - it is long
 *
 * Selection cannot honour an instruction such as "don't lead with the raise": it will still pick
 * the sentence with the figure. Instructions like that are routed to the curator as editor notes,
 * and the curator edits before sending.
 */
import { splitSentences } from "../text.js";

export interface CondenseOptions {
  /** Most points to keep. */
  maxPoints?: number;
  /** Word budget across all kept points. The first point is always kept, even if it exceeds this. */
  maxWords?: number;
  /** Longest a single point may be before it is cut at a word boundary. */
  maxPointChars?: number;
}

// Deliberately not "better": it marked down the plain fact "wave height is no better".
const JUDGEMENT = /\b(the story|framing|angle|quote|quotable|material|unusual|strongest|honest about|interesting|legible|hook|defensible)\b/i;
const PRONOUN_LED = /^(he|she|they|it|that|this|those|these|his|her|their)\b/i;

interface Scored { text: string; bullet: number; order: number; score: number; words: number }

export function condense(points: string[], opts: CondenseOptions = {}): string[] {
  const maxPoints = opts.maxPoints ?? 2;
  const maxWords = opts.maxWords ?? 40;
  const maxPointChars = opts.maxPointChars ?? 200;

  const scored: Scored[] = [];
  let order = 0;
  points.forEach((point, bullet) => {
    splitSentences(point).forEach((text, k) => {
      const words = text.split(/\s+/).filter(Boolean).length;
      if (words < 3) return; // a fragment says nothing on its own
      let score = 0;
      if (/\d/.test(text)) score += 3;
      if (k === 0) score += 2;
      score += Math.max(0, 1.5 - bullet * 0.5);
      if (JUDGEMENT.test(text)) score -= 2;
      if (PRONOUN_LED.test(text)) score -= 1;
      if (words > 45) score -= 2;
      else if (words > 30) score -= 1;
      scored.push({ text, bullet, order: order++, score, words });
    });
  });
  if (scored.length === 0) return [];

  // Best first; ties go to whichever came first in the write-up.
  const ranked = [...scored].sort((a, b) => b.score - a.score || a.order - b.order);
  const kept: Scored[] = [];
  let used = 0;
  for (const s of ranked) {
    if (kept.length >= maxPoints) break;
    if (kept.length > 0 && used + s.words > maxWords) continue;
    kept.push(s);
    used += s.words;
  }

  // Back into the order the source told it in.
  return kept.sort((a, b) => a.order - b.order).map((s) => cut(s.text, maxPointChars));
}

function cut(s: string, n: number): string {
  if (s.length <= n) return s;
  const head = s.slice(0, n);
  const at = head.lastIndexOf(" ");
  return (at > n / 2 ? head.slice(0, at) : head).replace(/[,;:\s—–-]+$/, "") + "…";
}
