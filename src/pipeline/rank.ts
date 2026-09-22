/**
 * Ranking affects display order and which items seed the pre-generated drafts. Nothing is dropped.
 * Score: type weight + recency (news, posts) or imminence (events) + summary present + confidence
 * + one point per related source (a story two sources carried matters more).
 */
import { isPastEvent, type Item } from "../schema.js";

export interface RankedItem {
  item: Item;
  score: number;
  reasons: string[];
}

const TYPE_WEIGHT: Record<string, number> = { event: 3, news: 3, ceo_update: 3, linkedin: 1, member_social: 2 };

export function rankItems(items: Item[], now: Date): RankedItem[] {
  const ranked = items.map((item) => {
    const reasons: string[] = [];
    let score = TYPE_WEIGHT[item.type] ?? 1;
    reasons.push(`${item.type} +${TYPE_WEIGHT[item.type] ?? 1}`);

    const days = (new Date(item.date).getTime() - now.getTime()) / 86_400_000;
    if (isPastEvent(item)) {
      // A look back at an event already held: listed for the curator, never outranking what is ahead.
      reasons.push(`held ${Math.max(0, Math.round(-days))}d ago +0`);
    } else if (item.type === "event") {
      const imminence = days <= 3 ? 3 : days <= 7 ? 2 : 1;
      score += imminence;
      reasons.push(`in ${Math.max(0, Math.round(days))}d +${imminence}`);
    } else {
      const age = -days;
      const recency = age <= 2 ? 3 : age <= 4 ? 2 : 1;
      score += recency;
      reasons.push(`${Math.max(0, Math.round(age))}d old +${recency}`);
    }
    if (!item.needs_summary) { score += 1; reasons.push("summary +1"); }
    if (item.confidence === "high") { score += 1; reasons.push("high confidence +1"); }
    if (item.related?.length) { score += item.related.length; reasons.push(`${item.related.length} related +${item.related.length}`); }
    if (item.requires_review) { score -= 2; reasons.push("requires review -2"); }
    return { item, score, reasons };
  });
  return ranked.sort((a, b) => b.score - a.score || a.item.date.localeCompare(b.item.date));
}
