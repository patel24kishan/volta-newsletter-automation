/**
 * Config the maintainer edits without a deploy. In the demo it is demo/config.json;
 * in production the same shape comes from a Google Sheet through this interface.
 */
import { readFile } from "node:fs/promises";
import type { ItemType } from "./schema.js";
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
}

export interface Config {
  timezone: string;
  /** Day the newsletter goes out, e.g. "monday". Shifts by the holiday rule. */
  send_day: string;
  /** Local time the reminder must be delivered by, "HH:MM". */
  reminder_time: string;
  /** Days of content to look back. */
  content_window_days: number;
  /** Days of events to look ahead. */
  events_window_days: number;
  /** Terms an item must mention to count as relevant (case-insensitive). */
  watchlist: string[];
  /** Extra closure days as YYYY-MM-DD, on top of CA-NS statutory holidays. */
  holiday_overrides: string[];
  alert_recipients: string[];
  sources: SourceConfig[];
}

export class ConfigError extends Error {}

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
  needStringArray("holiday_overrides");
  needStringArray("alert_recipients");

  if (typeof c.reminder_time === "string" && !/^\d{2}:\d{2}$/.test(c.reminder_time)) {
    errors.push("reminder_time must be HH:MM");
  }
  if (Array.isArray(c.holiday_overrides)) {
    for (const d of c.holiday_overrides as unknown[]) {
      if (typeof d === "string" && !/^\d{4}-\d{2}-\d{2}$/.test(d)) errors.push(`holiday_overrides entry not YYYY-MM-DD: ${d}`);
    }
  }

  const kinds: SourceKind[] = ["rss", "ics", "linkedin_company", "google_news", "slack_channel", "manual"];
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
      if (typeof src.id !== "string" || src.id === "") errors.push(`sources[${i}].id missing`);
      else if (ids.has(src.id)) errors.push(`duplicate source id ${src.id}`);
      else ids.add(src.id);
      if (!kinds.includes(src.kind as SourceKind)) errors.push(`sources[${i}].kind must be one of ${kinds.join(", ")}`);
      if (typeof src.type !== "string") errors.push(`sources[${i}].type missing`);

      if (src.kind === "google_news") {
        // The URL is built from the terms, so the maintainer never edits an encoded query string.
        const terms = src.terms;
        if (!Array.isArray(terms) || terms.length === 0 || !terms.every((t) => typeof t === "string" && t.trim() !== "")) {
          errors.push(`sources[${i}].terms must be a non-empty array of search terms for a google_news source`);
        } else {
          try {
            src.url = googleNewsUrl(terms as string[]);
          } catch (e) {
            errors.push(`sources[${i}]: ${(e as Error).message}`);
          }
        }
      } else if (src.kind === "slack_channel") {
        // Read over the Slack Web API, so there is no feed URL; it needs a channel id instead.
        if (typeof src.channel_id !== "string" || !/^[A-Z0-9]{6,}$/.test(src.channel_id)) {
          errors.push(`sources[${i}].channel_id must be a Slack channel id such as C0123ABCD for a slack_channel source`);
        }
        src.url = "";
      } else if (src.kind === "manual") {
        // Read from storage, so there is no feed URL. A hand-added event may have no link of its
        // own, so the page to fall back to is required rather than optional here.
        if (typeof src.fallback_link !== "string" || !/^https?:\/\//.test(src.fallback_link)) {
          errors.push(`sources[${i}].fallback_link must be an http(s) page for a manual source, used when an added event has no link of its own`);
        }
        src.url = "";
      } else if (typeof src.url !== "string" || !/^https?:\/\//.test(src.url)) {
        errors.push(`sources[${i}].url must be http(s)`);
      }
      if (typeof src.enabled !== "boolean") errors.push(`sources[${i}].enabled must be boolean`);
      if (src.fallback_link !== undefined && (typeof src.fallback_link !== "string" || !/^https?:\/\//.test(src.fallback_link))) {
        errors.push(`sources[${i}].fallback_link must be an http(s) URL when present`);
      }
    });
  }

  if (errors.length) throw new ConfigError(`${where}: ${errors.join("; ")}`);
  return c as unknown as Config;
}
