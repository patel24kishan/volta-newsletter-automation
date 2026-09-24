/**
 * Sources the curator added himself, and the one list every run reads.
 *
 * The config file (demo/config.json, a Google Sheet in production) stays the maintainer's: this
 * process never writes it, so a source the curator adds in Claude is kept in the database instead
 * and merged on top here. `effectiveSources` is the only place that merge happens, so the monthly
 * run, the pre-flight check and the tools all read exactly the same set.
 *
 * A stored source is turned into an ordinary SourceConfig and then put through the config file's
 * own `validateSource`, so both are held to the same rules, a news search still has its URL built
 * from its terms, and a row written by an older version can never reach a fetcher half-formed.
 */
import { validateSource, type Config, type SourceConfig } from "../config.js";
import type { CuratorSource, Storage } from "../storage.js";

/** Ids of curator sources start with this, so the list shows at a glance who added what. */
export const CURATOR_ID_PREFIX = "cur_";

/** What a curator source looks like as a source the fetchers understand, or why it cannot. */
export function toSourceConfig(row: CuratorSource): { source: SourceConfig } | { errors: string[] } {
  const src: Record<string, unknown> = {
    id: row.id,
    kind: row.kind,
    type: row.type,
    url: row.url,
    enabled: row.enabled,
    ...(row.terms.length ? { terms: row.terms } : {}),
    ...(row.channel_id ? { channel_id: row.channel_id } : {}),
    ...(row.fallback_link ? { fallback_link: row.fallback_link } : {}),
    // Absent means the newsletter's watchlist applies, as it does for every config source.
    ...(row.filtered ? { keywords: row.keywords } : {}),
  };
  const errors = validateSource(src, `source ${row.id}`);
  return errors.length ? { errors } : { source: src as unknown as SourceConfig };
}

export interface EffectiveSources {
  /** What the run reads: the config's sources, then the curator's. */
  sources: SourceConfig[];
  /** A curator source that cannot be used, and why. Shown in the source list, never thrown. */
  broken: Array<{ id: string; errors: string[] }>;
  /** Curator rows whose id a config source already uses; the config one wins. */
  shadowed: string[];
}

/**
 * Every source this run should read. The config's own sources come first and always win a clash of
 * ids, since the maintainer's list is the one the newsletter is designed around.
 *
 * A broken or shadowed curator row is reported rather than thrown: one bad row must never stop the
 * month from being prepared.
 */
export function describeSources(config: Pick<Config, "sources">, storage?: Pick<Storage, "listCuratorSources">): EffectiveSources {
  const sources = [...config.sources];
  const broken: EffectiveSources["broken"] = [];
  const shadowed: string[] = [];
  if (!storage) return { sources, broken, shadowed };

  const taken = new Set(sources.map((s) => s.id));
  for (const row of storage.listCuratorSources()) {
    if (taken.has(row.id)) {
      shadowed.push(row.id);
      continue;
    }
    const made = toSourceConfig(row);
    if ("errors" in made) {
      broken.push({ id: row.id, errors: made.errors });
      continue;
    }
    taken.add(row.id);
    sources.push(made.source);
  }
  return { sources, broken, shadowed };
}

/** The list itself, for the callers that only fetch. */
export function effectiveSources(config: Pick<Config, "sources">, storage?: Pick<Storage, "listCuratorSources">): SourceConfig[] {
  return describeSources(config, storage).sources;
}

/**
 * An id for a new curator source, from the curator's name for it, its address or its search terms.
 * It is frozen once created: item ids and his saved edits are keyed by it, so a rename would
 * orphan every edit he has made. `taken` is every id already in use, config sources included.
 */
export function curatorSourceId(from: { label?: string; url?: string; terms?: string[]; channel_id?: string }, taken: Iterable<string>): string {
  const words = from.label?.trim() || hostOf(from.url) || from.terms?.[0] || from.channel_id || "source";
  const slug = words.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "source";
  const used = new Set(taken);
  let id = `${CURATOR_ID_PREFIX}${slug}`;
  for (let n = 2; used.has(id); n++) id = `${CURATOR_ID_PREFIX}${slug}-${n}`;
  return id;
}

function hostOf(url?: string): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
