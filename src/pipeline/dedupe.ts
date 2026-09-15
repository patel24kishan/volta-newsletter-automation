/**
 * Dedupe across sources. Nothing is thrown away: a duplicate is folded into the surviving item as a
 * `related` link, so Bader still sees every source and every link (constraints 2 and 5).
 *
 * Three rules, applied in order:
 *  1. Same link after URL normalization (tracking params, hash, trailing slash, host case).
 *  2. Near-identical titles (token containment or Jaccard >= 0.6 after normalization).
 *  3. A non-event item that names an upcoming event's title and its calendar date is attached to
 *     that event (the LinkedIn "join us for yoga on September 24" case).
 *
 * Survivor choice: event > news > linkedin > other, then higher confidence, then earlier date.
 */
import { partsInZone } from "../clock.js";
import type { Item, RelatedLink } from "../schema.js";

export interface DedupeResult {
  items: Item[];
  /** Human-readable notes, one per fold, for the run log. */
  merges: string[];
}

const TRACKING = /^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$|ref$|source$|trk$)/i;
const STOPWORDS = new Set(["the", "a", "an", "and", "of", "at", "in", "on", "for", "to", "with", "our", "your", "us", "this", "that", "is", "are", "from", "by"]);
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

export function dedupeItems(input: Item[], timeZone: string): DedupeResult {
  const items: Item[] = [...input].sort(bySurvivorPreference).map((i) => {
    const copy: Item = { ...i };
    if (i.related) copy.related = [...i.related];
    return copy;
  });
  const merges: string[] = [];
  const survivors: Item[] = [];

  for (const cand of items) {
    const target = survivors.find((s) => sameLink(s, cand) || similarTitle(s, cand) || mentionsEvent(s, cand, timeZone));
    if (!target) {
      survivors.push(cand);
      continue;
    }
    fold(target, cand);
    merges.push(`"${cand.title}" (${cand.source}) folded into "${target.title}" (${target.source})`);
  }
  for (const s of survivors) if (s.related && s.related.length === 0) delete s.related;
  return { items: survivors, merges };
}

function fold(target: Item, dup: Item): void {
  const rel: RelatedLink = { source: dup.source, link: dup.link, title: dup.title };
  target.related ??= [];
  if (!target.related.some((r) => normalizeUrl(r.link) === normalizeUrl(rel.link))) target.related.push(rel);
  for (const r of dup.related ?? []) if (!target.related.some((x) => normalizeUrl(x.link) === normalizeUrl(r.link))) target.related.push(r);
  if (target.summary === "" && dup.summary !== "") {
    target.summary = dup.summary;
    target.needs_summary = false;
  }
  if (!dup.raw_excerpt || target.raw_excerpt.includes(dup.raw_excerpt)) return;
  target.raw_excerpt = `${target.raw_excerpt} || ${dup.raw_excerpt}`;
}

const TYPE_RANK: Record<string, number> = { event: 0, news: 1, ceo_update: 2, linkedin: 3, member_social: 4 };
const CONF_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

function bySurvivorPreference(a: Item, b: Item): number {
  return (TYPE_RANK[a.type] ?? 9) - (TYPE_RANK[b.type] ?? 9) || (CONF_RANK[a.confidence] ?? 9) - (CONF_RANK[b.confidence] ?? 9) || a.date.localeCompare(b.date);
}

export function normalizeUrl(u: string): string {
  try {
    const url = new URL(u);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    for (const k of [...url.searchParams.keys()]) if (TRACKING.test(k)) url.searchParams.delete(k);
    const path = url.pathname.replace(/\/+$/, "");
    const query = url.searchParams.toString();
    return `${url.protocol}//${url.host}${path}${query ? `?${query}` : ""}`;
  } catch {
    return u.trim();
  }
}

function sameLink(a: Item, b: Item): boolean {
  return normalizeUrl(a.link) === normalizeUrl(b.link);
}

export function titleTokens(title: string): Set<string> {
  return new Set(
    title.toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((t) => t && !STOPWORDS.has(t)),
  );
}

export function similarTitle(a: Item, b: Item): boolean {
  const ta = titleTokens(a.title), tb = titleTokens(b.title);
  if (ta.size < 2 || tb.size < 2) return false;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const smaller = Math.min(ta.size, tb.size);
  const containment = inter / smaller;
  const jaccard = inter / (ta.size + tb.size - inter);
  return (containment >= 0.8 && smaller >= 3) || jaccard >= 0.6;
}

/** `post` mentions `event`'s title (whole phrase) and its local calendar date. */
export function mentionsEvent(event: Item, post: Item, timeZone: string): boolean {
  if (event.type !== "event" || post.type === "event") return false;
  const title = event.title.trim().toLowerCase();
  if (title.length < 3) return false;
  const text = `${post.title} ${post.summary} ${post.raw_excerpt}`.toLowerCase();
  const titleRe = new RegExp(`(^|[^a-z0-9])${escapeRe(title)}([^a-z0-9]|$)`);
  if (!titleRe.test(text)) return false;
  const p = partsInZone(new Date(event.date), timeZone);
  const month = MONTHS[p.month - 1] ?? "";
  const mon3 = month.slice(0, 3);
  const day = String(p.day);
  // "September 24", "Sep 24", "Sept. 24th", "24 September"
  const monthRe = `${mon3}[a-z]*\\.?`;
  const dateRe = new RegExp(`\\b${monthRe}\\s+${day}(st|nd|rd|th)?\\b|\\b${day}(st|nd|rd|th)?\\s+${monthRe}`);
  return dateRe.test(text);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
