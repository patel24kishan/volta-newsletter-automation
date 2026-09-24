/**
 * Which words a source's items must mention to be kept.
 *
 * The newsletter has always had one list, the watchlist, applied to news feeds only: it is what
 * keeps a Volta story and drops the rest of the world's news. A source the curator adds himself
 * may carry its own list instead, because the reason he added it is rarely "Volta": a Halifax
 * startup feed, an ocean-tech blog, a partner's calendar. Without this, the watchlist would throw
 * away everything such a source publishes and he would see an empty section with no explanation.
 *
 * The rule, in one place so every source kind reads it the same way:
 *   - `keywords` absent  -> the newsletter's watchlist, exactly as before.
 *   - `keywords: []`     -> keep everything this source publishes.
 *   - `keywords: [...]`  -> keep only what mentions one of his words.
 */
import type { Config, SourceConfig } from "../config.js";
import type { Item } from "../schema.js";
import { mentionsAny } from "../text.js";

/** The words this source filters on. */
export function keywordsFor(source: Pick<SourceConfig, "keywords">, config: Pick<Config, "watchlist">): string[] {
  return source.keywords ?? config.watchlist;
}

/** True when the source filters on its own words rather than the newsletter's watchlist. */
export function hasOwnKeywords(source: Pick<SourceConfig, "keywords">): boolean {
  return source.keywords !== undefined;
}

/** What is matched: the words a reader would see, never the link or the id. */
export function haystackOf(item: Pick<Item, "title" | "summary" | "raw_excerpt">): string {
  return `${item.title} ${item.summary} ${item.raw_excerpt}`;
}

/**
 * Keep only the items that mention one of a curator source's own words.
 *
 * The news fetcher already filters as it reads (src/fetchers/rss.ts), so this second pass finds
 * nothing there. It exists for the kinds that never had a filter at all: a calendar, a LinkedIn
 * page, a Slack channel. It is applied to a source's items only when he gave that source keywords,
 * so nothing the maintainer configured changes behaviour.
 */
export function keepRelevant(
  source: Pick<SourceConfig, "keywords">,
  config: Pick<Config, "watchlist">,
  items: Item[],
): { items: Item[]; dropped: number } {
  if (!hasOwnKeywords(source)) return { items, dropped: 0 };
  const terms = keywordsFor(source, config);
  if (terms.length === 0) return { items, dropped: 0 };
  const kept = items.filter((it) => mentionsAny(haystackOf(it), terms));
  return { items: kept, dropped: items.length - kept.length };
}

/**
 * Whether a news item is about the right place, for a source filtered by the newsletter's own
 * watchlist. "Volta" is also a river in Ghana, a region of Ghana and a unit of electricity, so a
 * watchlist word on its own is not enough; the config's `local_terms` say what else must appear.
 * A source the curator gave his own keywords is exempt: he chose those words deliberately.
 */
export function isLocalEnough(
  source: Pick<SourceConfig, "keywords">,
  config: Pick<Config, "local_terms">,
  haystack: string,
): boolean {
  if (hasOwnKeywords(source)) return true;
  const terms = config.local_terms ?? [];
  return terms.length === 0 || mentionsAny(haystack, terms);
}
