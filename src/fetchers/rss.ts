/**
 * Feed fetcher for RSS 2.0 and Atom. Demo source: Google News search feed for Volta.
 * Atom is read here rather than in a second fetcher because the two formats differ only in where
 * the same handful of fields live, and plenty of sites publish Atom only. A curator who pastes
 * such a link was being told his link was wrong when it was not.
 * Keeps only items inside the content window and mentioning a watchlist term.
 * Summary is extracted from the description when it says more than the title; otherwise the
 * item is flagged needs_summary so Bader decides.
 */
import { XMLParser } from "fast-xml-parser";
import type { SourceConfig } from "../config.js";
import { fetchText as defaultFetchText } from "../http.js";
import { isAbsoluteHttpUrl, itemId, type Item } from "../schema.js";
import { collapseWhitespace, decodeEntities, firstSentences, mentionsAny, stripHtml } from "../text.js";
import { describeWindow, windowsOf } from "../schedule/period.js";
import { hasOwnKeywords, isLocalEnough, keywordsFor } from "../sources/relevance.js";
import type { FetchContext, FetchResult, Fetcher } from "./types.js";

/** What an RSS <item> and an Atom <entry> both come down to, already flattened to strings. */
export interface FeedEntry {
  title: string;
  link: string;
  /** The feed's own id for the entry (RSS <guid>, Atom <id>); falls back to the link. */
  guid: string;
  /** The date exactly as the feed wrote it; the caller parses it so it can warn on junk. */
  date: string;
  description: string;
  publisher: string;
}

export class RssFetcher implements Fetcher {
  readonly kind = "rss" as const;

  async fetch(source: SourceConfig, ctx: FetchContext): Promise<FetchResult> {
    const get = ctx.fetchText ?? defaultFetchText;
    let body: string;
    try {
      body = await get(source.url);
    } catch (e) {
      return { source: source.id, items: [], warnings: [], error: (e as Error).message, bytes: 0 };
    }
    const parsed = parseRss(body);
    if ("error" in parsed) {
      return { source: source.id, items: [], warnings: [], error: parsed.error, bytes: body.length };
    }

    const { content } = windowsOf(ctx);
    const { from, to: now } = content;
    const warnings: string[] = [];
    const items: Item[] = [];
    let outsideWindow = 0;
    let offTopic = 0;

    for (const entry of parsed.items) {
      const { title, link, guid, description, publisher } = entry;
      const date = parseDate(entry.date);

      if (!title || !isAbsoluteHttpUrl(link)) {
        warnings.push(`skipped item without title or absolute link: "${title || guid || "?"}"`);
        continue;
      }
      if (!date) {
        warnings.push(`skipped item without a parseable pubDate: "${title}"`);
        continue;
      }
      if (date < from || date > now) {
        outsideWindow++;
        continue;
      }
      const haystack = `${title} ${description} ${publisher}`;
      const terms = keywordsFor(source, ctx.config);
      if (!mentionsAny(haystack, terms)) {
        offTopic++;
        warnings.push(`off-topic (no ${hasOwnKeywords(source) ? "keyword for this source" : "watchlist term"}): "${title}"`);
        continue;
      }
      // A watchlist word alone is not enough for news: Volta is a river and a region in Ghana too.
      if (!isLocalEnough(source, ctx.config, haystack)) {
        offTopic++;
        warnings.push(`off-topic (mentions no local place): "${title}"`);
        continue;
      }

      const saysMore = description.length > title.length + 20 && !description.startsWith(title);
      const summary = saysMore ? firstSentences(description, 2, 280) : "";
      items.push({
        id: itemId(source.id, link),
        source: source.id,
        type: source.type,
        date: date.toISOString(),
        title,
        summary,
        needs_summary: summary === "",
        link,
        source_ref: guid,
        confidence: "high",
        requires_review: false,
        raw_excerpt: collapseWhitespace([title, publisher ? `(${publisher})` : "", description].filter(Boolean).join(" ")),
      });
    }

    if (outsideWindow) warnings.push(`${outsideWindow} item(s) outside the window (${describeWindow(content, ctx.config.timezone)})`);
    if (offTopic) warnings.push(`${offTopic} item(s) dropped as off-topic`);
    return { source: source.id, items, warnings, bytes: body.length };
  }
}

export function parseRss(body: string): { items: FeedEntry[]; title: string } | { error: string } {
  if (!body || body.trim() === "") return { error: "empty response body" };
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", textNodeName: "#text", cdataPropName: "#cdata" });
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(body) as Record<string, unknown>;
  } catch (e) {
    return { error: `not parseable as XML: ${(e as Error).message}` };
  }
  const rss = doc.rss as Record<string, unknown> | undefined;
  const channel = rss?.channel as Record<string, unknown> | undefined;
  if (channel) {
    return { items: children(channel.item).map(fromRssItem), title: text(channel.title) };
  }
  const feed = doc.feed as Record<string, unknown> | undefined;
  if (feed && typeof feed === "object") {
    // The feed's own title is the only publisher an entry without its own <source> has.
    const feedTitle = atomText(feed.title);
    return { items: children(feed.entry).map((e) => fromAtomEntry(e, feedTitle)), title: feedTitle };
  }
  return { error: "no <rss><channel> or <feed><entry> element; not an RSS or Atom feed" };
}

function fromRssItem(raw: Record<string, unknown>): FeedEntry {
  const link = text(raw.link);
  return {
    title: text(raw.title),
    link,
    guid: text(raw.guid) || link,
    date: text(raw.pubDate),
    description: stripHtml(text(raw.description)),
    publisher: text(raw.source),
  };
}

function fromAtomEntry(raw: Record<string, unknown>, feedTitle: string): FeedEntry {
  const id = text(raw.id);
  // An Atom id is often opaque ("t3_1abcde" on Reddit), so it stands in for the link only when
  // the feed happened to use a URL as the id.
  const link = linkHref(raw.link) || (isAbsoluteHttpUrl(id) ? id : "");
  // <published> is when the entry appeared; <updated> only says when it last changed, so it is
  // the fallback. <summary> is the short form by definition, so it wins over the full <content>.
  const source = raw.source as Record<string, unknown> | undefined;
  return {
    title: atomText(raw.title),
    link,
    guid: id || link,
    date: text(raw.published) || text(raw.updated),
    description: stripHtml(text(raw.summary !== undefined ? raw.summary : raw.content)),
    publisher: (source && typeof source === "object" ? atomText(source.title) : "") || feedTitle,
  };
}

/** fast-xml-parser gives one child as an object and repeats as an array; callers want a list. */
function children(v: unknown): Record<string, unknown>[] {
  if (Array.isArray(v)) return v as Record<string, unknown>[];
  if (v && typeof v === "object") return [v as Record<string, unknown>];
  return [];
}

/**
 * Atom keeps the URL in an attribute rather than in text, and an entry may carry several links.
 * rel is optional and means "alternate" when absent, which is the readable page we want; the
 * others (self, enclosure, replies) are used only when there is nothing better.
 */
function linkHref(v: unknown): string {
  const links = children(v);
  const alternate = links.find((l) => l["@_rel"] === undefined || l["@_rel"] === "alternate");
  return text(alternate?.["@_href"]) || text(links.find((l) => l["@_href"] !== undefined)?.["@_href"]);
}

/** An Atom title or content may be escaped HTML; anything else is taken as it stands. */
function atomText(v: unknown): string {
  const type = v && typeof v === "object" ? (v as Record<string, unknown>)["@_type"] : undefined;
  const s = text(v);
  return type === "html" || type === "xhtml" ? stripHtml(s) : s;
}

/** fast-xml-parser gives strings, numbers, or objects with #text/#cdata/@_ attrs; flatten to a string. */
function text(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return decodeEntities(v).trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("#cdata" in o) return text(o["#cdata"]);
    if ("#text" in o) return text(o["#text"]);
  }
  return "";
}

function parseDate(s: string): Date | undefined {
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : new Date(t);
}
