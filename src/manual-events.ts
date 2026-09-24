/**
 * Events the curator adds by hand for something no source lists yet. They are stored in SQLite and
 * re-emitted as items by the `manual` fetcher on every run, so they flow through dedupe, ranking,
 * drafting and the verifier like any other item. The source of such an item is the curator's own
 * entry: a draft can say only what was typed here (constraint 5).
 */
import { zonedToUtc } from "./clock.js";
import type { SourceConfig } from "./config.js";
import { isAbsoluteHttpUrl, itemId, normalizeLink, type Item } from "./schema.js";
import { collapseWhitespace } from "./text.js";

export const MANUAL_REF_PREFIX = "manual:";
export const MANUAL_LIMITS = { title: 120, location: 120, description: 280 } as const;

export interface NewManualEvent {
  title: string;
  /** ISO 8601 with an offset or Z. The form converts the curator's local time before it gets here. */
  starts_at: string;
  location?: string;
  description?: string;
  /** Blank means "use the source's fallback_link". */
  link?: string;
  /** An https image link or the full path of an image file on this computer (src/images.ts). */
  image?: string;
}

export interface ManualEvent {
  id: string;
  title: string;
  starts_at: string;
  location: string;
  description: string;
  link: string;
  /** "" when the event has no image. */
  image: string;
  created_at: string;
}

export type ManualEventErrors = Partial<Record<keyof NewManualEvent, string>>;

/** What a form collects: a calendar date and a wall-clock time, both as the curator sees them. */
export interface ManualEventFields {
  title: string;
  /** YYYY-MM-DD. */
  date: string;
  /** HH:MM, 24-hour. */
  time: string;
  location?: string;
  description?: string;
  link?: string;
  /** An https image link or the full path of an image file on this computer. */
  image?: string;
}

/**
 * Turn what the curator typed into a storable event. The date and time are read as wall-clock in
 * the newsletter's own timezone, never the server's, so a container running in UTC still records
 * the hour Bader meant. An unparseable date or time yields an empty start, which validation
 * reports against that field rather than guessing.
 */
export function manualEventFromFields(f: ManualEventFields, timeZone: string): NewManualEvent {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(f.date ?? "");
  const t = /^(\d{2}):(\d{2})$/.exec(f.time ?? "");
  const starts_at = d && t
    ? zonedToUtc(Number(d[1]), Number(d[2]), Number(d[3]), Number(t[1]), Number(t[2]), 0, timeZone).toISOString()
    : "";
  const e: NewManualEvent = { title: f.title ?? "", starts_at };
  if (f.location) e.location = f.location;
  if (f.description) e.description = f.description;
  // Taken as typed except for the scheme: "www.eventbrite.com/e/1" is what people paste.
  if (f.link) e.link = normalizeLink(f.link);
  if (f.image) e.image = f.image;
  return e;
}

export function isManualItem(item: Pick<Item, "source_ref">): boolean {
  return item.source_ref.startsWith(MANUAL_REF_PREFIX);
}

/** Problems keyed by field, so a form can show each next to its own input. Empty means valid. */
export function validateManualEvent(e: NewManualEvent, now?: Date): ManualEventErrors {
  const errors: ManualEventErrors = {};
  const title = collapseWhitespace(e.title ?? "");
  if (!title) errors.title = "Enter a title.";
  else if (title.length > MANUAL_LIMITS.title) errors.title = `Keep the title under ${MANUAL_LIMITS.title} characters.`;

  const start = typeof e.starts_at === "string" && /(Z|[+-]\d{2}:\d{2})$/.test(e.starts_at) ? Date.parse(e.starts_at) : Number.NaN;
  if (Number.isNaN(start)) errors.starts_at = "Choose a valid date and time.";
  else if (now && start < now.getTime()) errors.starts_at = "Choose a start time in the future.";

  if (collapseWhitespace(e.location ?? "").length > MANUAL_LIMITS.location) errors.location = `Keep the location under ${MANUAL_LIMITS.location} characters.`;
  if (collapseWhitespace(e.description ?? "").length > MANUAL_LIMITS.description) errors.description = `Keep the description under ${MANUAL_LIMITS.description} characters.`;
  const link = normalizeLink(e.link ?? "");
  if (link && !isAbsoluteHttpUrl(link)) errors.link = "Enter a full link starting with http:// or https://, or leave it blank.";
  return errors;
}

/**
 * The item a hand-added event becomes. Medium confidence, so a real calendar listing of the same
 * event wins the dedupe. Its text is exactly what was typed, so the verifier's corpus matches it.
 */
export function itemFromManualEvent(e: ManualEvent, source: Pick<SourceConfig, "id" | "type">, fallbackLink: string): Item {
  const link = e.link || fallbackLink;
  const item: Item = {
    id: itemId(source.id, `${e.id}@${link}`),
    source: source.id,
    type: source.type,
    date: e.starts_at,
    title: e.title,
    summary: e.description,
    needs_summary: e.description === "",
    link,
    source_ref: `${MANUAL_REF_PREFIX}${e.id}`,
    confidence: "medium",
    requires_review: false,
    raw_excerpt: collapseWhitespace([e.title, e.location ? `Location: ${e.location}.` : "", e.description].filter(Boolean).join(" ")),
  };
  if (e.location) item.location = e.location;
  if (e.image) item.image = e.image;
  return item;
}
