/**
 * RSS 2.0 fetcher. Demo source: Google News search feed for Volta.
 * Keeps only items inside the content window and mentioning a watchlist term.
 * Summary is extracted from the description when it says more than the title; otherwise the
 * item is flagged needs_summary so Bader decides.
 */
import { XMLParser } from "fast-xml-parser";
import type { SourceConfig } from "../config.js";
import { fetchText as defaultFetchText } from "../http.js";
import { isAbsoluteHttpUrl, itemId, type Item } from "../schema.js";
import { collapseWhitespace, decodeEntities, firstSentences, mentionsAny, stripHtml } from "../text.js";
import type { FetchContext, FetchResult, Fetcher } from "./types.js";

interface RawRssItem {
  title?: unknown;
  link?: unknown;
  guid?: unknown;
  pubDate?: unknown;
  description?: unknown;
  source?: unknown;
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

    const now = ctx.clock.now();
    const from = new Date(now.getTime() - ctx.config.content_window_days * 86_400_000);
    const warnings: string[] = [];
    const items: Item[] = [];
    let outsideWindow = 0;
    let offTopic = 0;

    for (const raw of parsed.items) {
      const title = text(raw.title);
      const link = text(raw.link);
      const guid = text(raw.guid) || link;
      const description = stripHtml(text(raw.description));
      const publisher = text(raw.source);
      const date = parseDate(text(raw.pubDate));

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
      if (!mentionsAny(haystack, ctx.config.watchlist)) {
        offTopic++;
        warnings.push(`off-topic (no watchlist term): "${title}"`);
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

    if (outsideWindow) warnings.push(`${outsideWindow} item(s) outside the ${ctx.config.content_window_days}-day window`);
    if (offTopic) warnings.push(`${offTopic} item(s) dropped as off-topic`);
    return { source: source.id, items, warnings, bytes: body.length };
  }
}

export function parseRss(body: string): { items: RawRssItem[]; title: string } | { error: string } {
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
  if (!channel) return { error: "no <rss><channel> element; not an RSS 2.0 feed" };
  const rawItems = channel.item;
  const items: RawRssItem[] = Array.isArray(rawItems) ? (rawItems as RawRssItem[]) : rawItems ? [rawItems as RawRssItem] : [];
  return { items, title: text(channel.title) };
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
