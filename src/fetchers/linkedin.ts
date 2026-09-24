/**
 * LinkedIn company-page fetcher. Demo source: Volta's own public company page, fetched as a guest.
 *
 * Primary parse: the page embeds JSON-LD (`DiscussionForumPosting` nodes) with datePublished, the
 * permalink, and the full post text. Fallback parse, when JSON-LD is absent: post permalinks in
 * the HTML, dated from the activity id (top bits are a millisecond timestamp), titled from the slug,
 * flagged needs_summary. A login wall is reported as an error so the pre-flight alerts loudly
 * (constraint 8) instead of quietly producing an empty week.
 *
 * Caveats recorded in PLAN.md section 11: one request per run, never polling; markup can change;
 * LinkedIn's terms restrict automated collection, so Volta reviews this before production.
 */
import type { SourceConfig } from "../config.js";
import { fetchText as defaultFetchText } from "../http.js";
import { isAbsoluteHttpUrl, itemId, type Item } from "../schema.js";
import { collapseWhitespace, decodeEntities, firstSentences } from "../text.js";
import { describeWindow, windowsOf } from "../schedule/period.js";
import type { FetchContext, FetchResult, Fetcher } from "./types.js";

export interface LinkedInPost {
  url: string;
  text: string;
  /** ISO timestamp. From JSON-LD when available, else derived from the activity id. */
  date: string;
  activityId: string;
  author: string;
  /** "jsonld" or "permalink" (fallback). */
  via: "jsonld" | "permalink";
}

const PERMALINK = /https:\/\/www\.linkedin\.com\/posts\/([A-Za-z0-9_-]+?)_([A-Za-z0-9_-]*?)-activity-(\d{15,25})-([A-Za-z0-9_-]{2,8})/g;

export class LinkedInCompanyFetcher implements Fetcher {
  readonly kind = "linkedin_company" as const;

  async fetch(source: SourceConfig, ctx: FetchContext): Promise<FetchResult> {
    const get = ctx.fetchText ?? defaultFetchText;
    let html: string;
    try {
      html = await get(source.url);
    } catch (e) {
      return { source: source.id, items: [], warnings: [], error: (e as Error).message, bytes: 0 };
    }

    const warnings: string[] = [];
    let posts = parseJsonLdPosts(html);
    if (posts.length === 0) {
      posts = parsePermalinkPosts(html);
      if (posts.length > 0) warnings.push(`no JSON-LD posts; fell back to ${posts.length} permalink(s) with slug titles and activity-id dates`);
    }
    if (posts.length === 0) {
      if (looksLikeLoginWall(html)) {
        return { source: source.id, items: [], warnings, error: "LinkedIn served a login wall instead of the public company page; no posts readable this run", bytes: html.length };
      }
      return { source: source.id, items: [], warnings: [...warnings, "page fetched but no posts found; markup may have changed"], bytes: html.length };
    }

    const { content } = windowsOf(ctx);
    const { from, to: now } = content;
    const items: Item[] = [];
    const seen = new Set<string>();
    let outside = 0;

    for (const p of posts) {
      if (seen.has(p.activityId)) continue;
      seen.add(p.activityId);
      const d = new Date(p.date);
      if (Number.isNaN(d.getTime())) {
        warnings.push(`skipped post with unparseable date: ${p.url}`);
        continue;
      }
      if (d < from || d > now) {
        outside++;
        continue;
      }
      if (!isAbsoluteHttpUrl(p.url)) continue;
      const text = collapseWhitespace(p.text);
      const title = text ? firstSentences(text, 1, 100) : titleFromSlug(p.url);
      const summary = p.via === "jsonld" && text ? firstSentences(text, 2, 280) : "";
      items.push({
        id: itemId(source.id, p.url),
        source: source.id,
        type: source.type,
        date: d.toISOString(),
        title,
        summary,
        needs_summary: summary === "",
        link: p.url,
        source_ref: `activity:${p.activityId}`,
        confidence: p.via === "jsonld" ? "high" : "medium",
        // Without the post's own words the title is a fragment of its address ("What happens when
        // you bring a room full of"). It is held, so Bader decides rather than it going out ticked.
        requires_review: !text,
        ...(text ? {} : { hold_note: "LinkedIn gave only the link, not the post's words: check what it says before ticking it" }),
        raw_excerpt: text || title,
      });
    }

    items.sort((a, b) => b.date.localeCompare(a.date));
    if (outside) warnings.push(`${outside} post(s) outside the window (${describeWindow(content, ctx.config.timezone)})`);
    // The public page shows only the most recent posts. If even the oldest one shown is inside the
    // window, earlier posts in it may exist that this run could not see; say so rather than imply
    // the list is complete.
    const dates = posts.map((p) => Date.parse(p.date)).filter((t) => !Number.isNaN(t));
    if (dates.length && Math.min(...dates) > from.getTime()) {
      warnings.push(`LinkedIn's public page only reached back to ${new Date(Math.min(...dates)).toISOString().slice(0, 10)}; posts earlier in the window may be missing`);
    }
    return { source: source.id, items, warnings, bytes: html.length };
  }
}

/** Every <script type="application/ld+json"> block, parsed; DiscussionForumPosting nodes collected. */
export function parseJsonLdPosts(html: string): LinkedInPost[] {
  const posts: LinkedInPost[] = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    let doc: unknown;
    try {
      doc = JSON.parse(decodeEntities(m[1] ?? ""));
    } catch {
      continue;
    }
    for (const node of walkNodes(doc)) {
      if (node["@type"] !== "DiscussionForumPosting") continue;
      const url = String(node.url ?? node.mainEntityOfPage ?? "");
      const id = activityIdFromUrl(url);
      if (!id) continue;
      const date = typeof node.datePublished === "string" ? node.datePublished : activityIdToDate(id).toISOString();
      const author = typeof node.author === "object" && node.author ? String((node.author as Record<string, unknown>).name ?? "") : "";
      posts.push({ url, text: String(node.text ?? ""), date, activityId: id, author, via: "jsonld" });
    }
  }
  return posts;
}

function* walkNodes(doc: unknown): Generator<Record<string, unknown>> {
  if (Array.isArray(doc)) {
    for (const d of doc) yield* walkNodes(d);
  } else if (typeof doc === "object" && doc !== null) {
    const o = doc as Record<string, unknown>;
    yield o;
    if (Array.isArray(o["@graph"])) yield* walkNodes(o["@graph"]);
  }
}

/** Fallback: unique post permalinks found anywhere in the HTML. */
export function parsePermalinkPosts(html: string): LinkedInPost[] {
  const posts: LinkedInPost[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(PERMALINK)) {
    const id = m[3] ?? "";
    if (seen.has(id)) continue;
    seen.add(id);
    const url = m[0];
    posts.push({ url, text: "", date: activityIdToDate(id).toISOString(), activityId: id, author: m[1] ?? "", via: "permalink" });
  }
  return posts;
}

export function activityIdFromUrl(url: string): string | undefined {
  const m = /-activity-(\d{15,25})-/.exec(url) ?? /activity[:-](\d{15,25})/.exec(url);
  return m?.[1];
}

/** LinkedIn activity ids are Snowflake-style: the top 41 bits are a Unix millisecond timestamp. */
export function activityIdToDate(id: string): Date {
  return new Date(Number(BigInt(id) >> 22n));
}

export function titleFromSlug(url: string): string {
  const m = /\/posts\/[A-Za-z0-9_-]+?_([A-Za-z0-9_-]*?)-activity-/.exec(url);
  const slug = (m?.[1] ?? "").replace(/-/g, " ").trim();
  return slug ? slug.charAt(0).toUpperCase() + slug.slice(1) : "LinkedIn post";
}

/** Heuristic: no posts, and the page is the guest gate rather than the company page. */
export function looksLikeLoginWall(html: string): boolean {
  const h = html.toLowerCase();
  if (/\/authwall|\/uas\/login|\/checkpoint\/|\/login\?/.test(h)) return true;
  if (/sign in to view|join now to see|sign in to see/.test(h)) return true;
  const hasCompanyContent = /application\/ld\+json/.test(h) && /"organization"/.test(h);
  return !hasCompanyContent && /<form[^>]+(login|signin)/.test(h);
}
