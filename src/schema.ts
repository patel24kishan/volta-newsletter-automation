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
