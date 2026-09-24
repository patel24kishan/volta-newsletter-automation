/**
 * Config the maintainer edits without a deploy. In the demo it is demo/config.json;
 * in production the same shape comes from a Google Sheet through this interface.
 */
import { readFile } from "node:fs/promises";
import { isAbsoluteHttpUrl, normalizeLink, type ItemType } from "./schema.js";
import { googleNewsUrl } from "./sources/google-news.js";

export type SourceKind = "rss" | "ics" | "linkedin_company" | "google_news" | "slack_channel" | "manual";

export interface SourceConfig {
  /** Stable id used in Item.source and in alerts. */
  id: string;
  kind: SourceKind;
  type: ItemType;
  /** Resolved feed URL. For a google_news source this is built from `terms` at load time. */
  url: string;
  enabled: boolean;
  /** Human-facing page to link when an individual item has no URL of its own (events feeds). */
  fallback_link?: string;
  /**
   * google_news only: the search terms to track, OR'd together. Terms containing a space are
   * searched as exact phrases. Edit this list to add or remove coverage; no deploy needed.
   */
  terms?: string[];
  /** slack_channel only: the channel to read, e.g. C0123ABCD. Found via the channel's About tab. */
  channel_id?: string;
  /**
   * Only for a source the curator added: keep only its items mentioning one of these words. Absent
   * means the newsletter's own watchlist applies, as it always has; an empty list keeps everything
   * the source publishes. Config sources never set it, so their behaviour is unchanged.
   */
  keywords?: string[];
}

/** The layouts a draft can be built in. One is chosen per newsletter; see DRAFT_LAYOUTS. */
export type DraftLayout = "brief" | "standard" | "events-first";
export const DRAFT_LAYOUTS: DraftLayout[] = ["brief", "standard", "events-first"];

/** How often the newsletter goes out. See src/schedule/period.ts for what each one fetches. */
export type Cadence = "weekly" | "monthly";
export const CADENCES: Cadence[] = ["weekly", "monthly"];

export interface Config {
  timezone: string;
  /** Which layout the newsletter is built in. Changing it needs no deploy. */
  draft_layout: DraftLayout;
  /**
   * How often the newsletter goes out. Optional so older configs keep loading: absent means weekly.
   * Monthly goes out on the first workday of the month and reads by calendar month, not day counts.
   */
  cadence?: Cadence;
  /** Day the newsletter goes out, e.g. "monday". Shifts by the holiday rule. */
  send_day: string;
  /** Local time the reminder must be delivered by, "HH:MM". */
  reminder_time: string;
  /**
   * Monthly only: for how many days after the first workday a reminder that could not be shown
   * (the computer was off, say) is still shown late. After that the month is marked missed.
   * Optional; 7 when absent.
   */
  catch_up_days?: number;
  /**
   * News only: an item must mention one of these as well as a watchlist word, so a story about the
   * Volta Region of Ghana or the Volta River Authority does not read as Halifax news. Optional, and
   * absent means the watchlist alone decides, as it used to. It never applies to a source the
   * curator gave its own keywords: those are his choice.
   */
  local_terms?: string[];
  /** Days of content to look back (weekly cadence). */
  content_window_days: number;
  /** Days of events to look ahead (weekly cadence). */
  events_window_days: number;
  /** Terms an item must mention to count as relevant (case-insensitive). */
  watchlist: string[];
  /** Extra closure days as YYYY-MM-DD, on top of CA-NS statutory holidays. */
  holiday_overrides: string[];
  alert_recipients: string[];
  sources: SourceConfig[];
}

export class ConfigError extends Error {}

/** The cadence a config asks for; weekly when it does not say. */
export function cadenceOf(config: Pick<Config, "cadence">): Cadence {
  return config.cadence ?? "weekly";
}

export async function loadConfig(path: string): Promise<Config> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (e) {
    throw new ConfigError(`cannot read config at ${path}: ${(e as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new ConfigError(`config at ${path} is not valid JSON: ${(e as Error).message}`);
  }
  return validateConfig(parsed, path);
}

export const SOURCE_KINDS: SourceKind[] = ["rss", "ics", "linkedin_company", "google_news", "slack_channel", "manual"];

/**
 * Check one source and fill in what it derives, returning the reasons it is wrong. It runs for
 * every source in the config file and, unchanged, for a source the curator adds at runtime
 * (src/sources/curator-sources.ts), so both are held to the same rules and read the same errors.
 *
 * It writes back to `src`: a google_news source's URL is built from its terms, and the kinds that
 * are not read over HTTP get an empty one.
 */
/**
 * An address field, repaired in place and then judged. The scheme is the part people leave off, in
 * a config file as much as in the chat, so it is filled in here rather than refused — the same
 * rule `add_event` follows, so the two address boxes Bader sees behave alike. It only ever adds a
 * scheme, so a genuinely wrong address is still wrong and still reported.
 */
function fixLink(src: Record<string, unknown>, field: "url" | "fallback_link"): boolean {
  if (typeof src[field] !== "string") return false;
  src[field] = normalizeLink(src[field]);
  return isAbsoluteHttpUrl(src[field] as string);
}

export function validateSource(src: Record<string, unknown>, where: string): string[] {
  const errors: string[] = [];
  if (typeof src.id !== "string" || src.id === "") errors.push(`${where}.id missing`);
  if (!SOURCE_KINDS.includes(src.kind as SourceKind)) errors.push(`${where}.kind must be one of ${SOURCE_KINDS.join(", ")}`);
  if (typeof src.type !== "string") errors.push(`${where}.type missing`);

  if (src.kind === "google_news") {
    // The URL is built from the terms, so the maintainer never edits an encoded query string.
    const terms = src.terms;
    if (!Array.isArray(terms) || terms.length === 0 || !terms.every((t) => typeof t === "string" && t.trim() !== "")) {
      errors.push(`${where}.terms must be a non-empty array of search terms for a google_news source`);
    } else {
      try {
        src.url = googleNewsUrl(terms as string[]);
      } catch (e) {
        errors.push(`${where}: ${(e as Error).message}`);
      }
    }
  } else if (src.kind === "slack_channel") {
    // Read over the Slack Web API, so there is no feed URL; it needs a channel id instead.
    if (typeof src.channel_id !== "string" || !/^[A-Z0-9]{6,}$/.test(src.channel_id)) {
      errors.push(`${where}.channel_id must be a Slack channel id such as C0123ABCD for a slack_channel source`);
    }
    src.url = "";
  } else if (src.kind === "manual") {
    // Read from storage, so there is no feed URL. A hand-added event may have no link of its
    // own, so the page to fall back to is required rather than optional here.
    if (!fixLink(src, "fallback_link")) {
      errors.push(`${where}.fallback_link must be an http(s) page for a manual source, used when an added event has no link of its own`);
    }
    src.url = "";
  } else if (!fixLink(src, "url")) {
    errors.push(`${where}.url must be http(s)`);
  }
  if (typeof src.enabled !== "boolean") errors.push(`${where}.enabled must be boolean`);
  if (src.fallback_link !== undefined && !fixLink(src, "fallback_link")) {
    errors.push(`${where}.fallback_link must be an http(s) URL when present`);
  }
  return errors;
}

export function validateConfig(value: unknown, where = "config"): Config {
  const errors: string[] = [];
  if (typeof value !== "object" || value === null) throw new ConfigError(`${where}: not an object`);
  const c = value as Record<string, unknown>;

  const needString = (k: string) => {
    if (typeof c[k] !== "string" || (c[k] as string).trim() === "") errors.push(`${k} must be a non-empty string`);
  };
  const needPosInt = (k: string) => {
    if (!Number.isInteger(c[k]) || (c[k] as number) <= 0) errors.push(`${k} must be a positive integer`);
  };
  const needStringArray = (k: string) => {
    if (!Array.isArray(c[k]) || !(c[k] as unknown[]).every((s) => typeof s === "string")) {
      errors.push(`${k} must be an array of strings`);
    }
  };

  needString("timezone");
  needString("send_day");
  needString("reminder_time");
  needPosInt("content_window_days");
  needPosInt("events_window_days");
  needStringArray("watchlist");
  if (c.local_terms !== undefined) needStringArray("local_terms");
  needStringArray("holiday_overrides");
  needStringArray("alert_recipients");

  if (c.catch_up_days !== undefined && (!Number.isInteger(c.catch_up_days) || (c.catch_up_days as number) < 1 || (c.catch_up_days as number) > 31)) {
    errors.push("catch_up_days must be a whole number of days from 1 to 31 when present");
  }
  if (typeof c.reminder_time === "string" && !/^\d{2}:\d{2}$/.test(c.reminder_time)) {
    errors.push("reminder_time must be HH:MM");
  }
  if (c.cadence !== undefined && !CADENCES.includes(c.cadence as Cadence)) {
    errors.push(`cadence must be one of ${CADENCES.join(", ")} when present`);
  }
  if (!DRAFT_LAYOUTS.includes(c.draft_layout as DraftLayout)) {
    errors.push(`draft_layout must be one of ${DRAFT_LAYOUTS.join(", ")}`);
  }
  if (Array.isArray(c.holiday_overrides)) {
    for (const d of c.holiday_overrides as unknown[]) {
      if (typeof d === "string" && !/^\d{4}-\d{2}-\d{2}$/.test(d)) errors.push(`holiday_overrides entry not YYYY-MM-DD: ${d}`);
    }
  }

  if (!Array.isArray(c.sources) || c.sources.length === 0) {
    errors.push("sources must be a non-empty array");
  } else {
    const ids = new Set<string>();
    (c.sources as unknown[]).forEach((s, i) => {
      if (typeof s !== "object" || s === null) {
        errors.push(`sources[${i}] is not an object`);
        return;
      }
      const src = s as Record<string, unknown>;
      if (typeof src.id === "string" && src.id !== "") {
        if (ids.has(src.id)) errors.push(`duplicate source id ${src.id}`);
        else ids.add(src.id);
      }
      errors.push(...validateSource(src, `sources[${i}]`));
    });
  }

  if (errors.length) throw new ConfigError(`${where}: ${errors.join("; ")}`);
  return c as unknown as Config;
}
