/**
 * The one item schema every source normalizes into.
 * Constraint 5: every item traces to a retrieved source and carries its link.
 */

export const ITEM_TYPES = ["news", "event", "ceo_update", "member_social", "linkedin"] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

export const CONFIDENCE_LEVELS = ["high", "medium", "low"] as const;
export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

export interface Item {
  /** Stable id: `${source}:${hash of link}`. */
  id: string;
  /** Config source id this item came from, e.g. "google-news". */
  source: string;
  type: ItemType;
  /** ISO 8601 timestamp of the item (publish time, event start, post time). */
  date: string;
  title: string;
  /** Extractive summary, or empty string when nothing usable was extracted. */
  summary: string;
  /** True when summary is empty or too weak; Bader is prompted to decide. */
  needs_summary: boolean;
  /** Absolute URL that resolves to the source. Never empty. */
  link: string;
  /** Where inside the source this came from: feed guid, VEVENT uid, activity id. */
  source_ref: string;
  confidence: Confidence;
  /** True for items a human must read before they can appear in a draft. */
  requires_review: boolean;
  /** Verbatim text retrieved from the source; the verifier checks drafts against this. */
  raw_excerpt: string;
  /** Events only: venue or address as given by the source. */
  location?: string;
  /** Other sources that carried the same story, attached by dedupe. Each keeps its own link. */
  related?: RelatedLink[];
  /** Reader-facing points taken from the source, shown in a draft under "Key insights". */
  insights?: string[];
  /**
   * Notes the source addressed to the editor ("confirm she has cleared this before we run it").
   * Shown to the curator next to the drafts. Never rendered into a newsletter.
   */
  editor_notes?: string[];
  /** Why a requires_review item is on hold, as the source put it, e.g. "REVISIT w/c Sep 28 (embargo)". */
  hold_note?: string;
  /** Who the item is about, e.g. "Yuki Tanaka, co-founder". */
  byline?: string;
  /**
   * Slack's permalink for the message this item came from, when it came from a Slack channel and
   * its main link points elsewhere. For the curator's list only; never rendered into a newsletter.
   */
  message_link?: string;
  /**
   * Events only: whether the event was already held or still to come when it was fetched. Decided
   * once, from the run's windows, so the list the curator saw and the newsletter built days later
   * agree. Absent on events from before this field existed, which count as upcoming.
   */
  event_timing?: EventTiming;
}

export type EventTiming = "past" | "upcoming";

/** An event already held when it was fetched: listed and printed apart from what is coming up. */
export function isPastEvent(it: Pick<Item, "type" | "event_timing">): boolean {
  return it.type === "event" && it.event_timing === "past";
}

/** The optional fields stored together as one JSON column. */
export const EXTRA_FIELDS = ["insights", "editor_notes", "hold_note", "byline", "message_link", "event_timing"] as const;

export interface RelatedLink {
  source: string;
  link: string;
  title: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export function validateItem(value: unknown): ValidationResult {
  const errors: string[] = [];
  if (typeof value !== "object" || value === null) {
    return { ok: false, errors: ["item is not an object"] };
  }
  const it = value as Record<string, unknown>;

  const str = (key: keyof Item, allowEmpty = false) => {
    const v = it[key];
    if (typeof v !== "string") errors.push(`${key} must be a string`);
    else if (!allowEmpty && v.trim() === "") errors.push(`${key} must not be empty`);
  };
  const bool = (key: keyof Item) => {
    if (typeof it[key] !== "boolean") errors.push(`${key} must be a boolean`);
  };

  str("id");
  str("source");
  str("title");
  str("source_ref");
  str("summary", true);
  str("raw_excerpt", true);
  bool("needs_summary");
  bool("requires_review");
  if ("location" in it && it.location !== undefined && typeof it.location !== "string") errors.push("location must be a string when present");
  for (const key of ["insights", "editor_notes"] as const) {
    const v = it[key];
    if (v !== undefined && (!Array.isArray(v) || !v.every((s) => typeof s === "string"))) errors.push(`${key} must be an array of strings when present`);
  }
  for (const key of ["hold_note", "byline"] as const) {
    if (it[key] !== undefined && typeof it[key] !== "string") errors.push(`${key} must be a string when present`);
  }
  if (it.event_timing !== undefined && it.event_timing !== "past" && it.event_timing !== "upcoming") {
    errors.push("event_timing must be past or upcoming when present");
  }
  if (it.message_link !== undefined && (typeof it.message_link !== "string" || !isAbsoluteHttpUrl(it.message_link))) {
    errors.push("message_link must be an absolute http(s) link when present");
  }
  if ("related" in it && it.related !== undefined) {
    if (!Array.isArray(it.related)) errors.push("related must be an array when present");
    else for (const r of it.related as unknown[]) {
      const o = r as Record<string, unknown>;
      if (typeof o !== "object" || o === null || typeof o.source !== "string" || typeof o.title !== "string" || typeof o.link !== "string" || !isAbsoluteHttpUrl(o.link)) {
        errors.push("related entries need source, title and an absolute http(s) link");
        break;
      }
    }
  }

  if (!ITEM_TYPES.includes(it.type as ItemType)) errors.push(`type must be one of ${ITEM_TYPES.join(", ")}`);
  if (!CONFIDENCE_LEVELS.includes(it.confidence as Confidence)) {
    errors.push(`confidence must be one of ${CONFIDENCE_LEVELS.join(", ")}`);
  }
  if (typeof it.date !== "string" || !ISO_DATE.test(it.date) || Number.isNaN(Date.parse(it.date))) {
    errors.push("date must be an ISO 8601 timestamp with timezone");
  }
  if (typeof it.link !== "string" || !isAbsoluteHttpUrl(it.link)) {
    errors.push("link must be an absolute http(s) URL");
  }
  if (typeof it.summary === "string" && typeof it.needs_summary === "boolean") {
    if (it.summary.trim() === "" && it.needs_summary !== true) {
      errors.push("needs_summary must be true when summary is empty");
    }
  }

  return { ok: errors.length === 0, errors };
}

export function isAbsoluteHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** Deterministic id from source and link so re-fetching the same item yields the same id. */
export function itemId(source: string, link: string): string {
  return `${source}:${fnv1a(link)}`;
}

function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
