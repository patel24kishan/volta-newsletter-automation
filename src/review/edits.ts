/**
 * The curator's own wording, applied on top of what the sources said.
 *
 * An edit is kept as a separate record (storage table `curator_edits`), never written into the
 * item: the source text stays exactly as fetched, a re-fetch cannot lose the edit, and clearing
 * the edit brings the source text back. Edits are applied to a copy of each item just before a
 * draft is built, so every rebuild keeps them whatever the selection.
 *
 * Why the verifier accepts them: an edited value becomes that item's field (its summary, its
 * location, its date), and the verifier checks a draft against the items it was built from. So
 * the curator's words are accepted because they are now the item's own text, and a name or date
 * that neither the source nor the curator gave is still rejected. Each edited copy says which
 * fields were changed (`edited_fields`), so nothing is silently reworded.
 */
import { zonedToUtc } from "../clock.js";
import { checkImage } from "../images.js";
import { isManualItem, MANUAL_LIMITS } from "../manual-events.js";
import { isAbsoluteHttpUrl, normalizeLink, type Item } from "../schema.js";
import type { CuratorEdit } from "../storage.js";
import { collapseWhitespace } from "../text.js";

/**
 * What the curator can reword. `title` and `image` only on events the curator added: a sourced
 * item keeps the title its source gave it, and only added events carry an image.
 */
export const EDIT_FIELDS = ["title", "summary", "starts_at", "location", "link", "image"] as const;
export type EditField = (typeof EDIT_FIELDS)[number];

/** What each field is called when Claude reads it back to the curator. */
export const EDIT_FIELD_LABEL: Record<EditField, string> = {
  title: "title", summary: "description", starts_at: "date and time", location: "location", link: "link", image: "image",
};

export const EDIT_LIMITS = { title: MANUAL_LIMITS.title, summary: 600, location: 120 } as const;

export function isEditField(f: string): f is EditField {
  return (EDIT_FIELDS as readonly string[]).includes(f);
}

/**
 * The stored form of an edit, or why it cannot be saved. `starts_at` is given as the curator reads
 * it, "YYYY-MM-DD HH:MM" in the newsletter's timezone, and stored as an ISO instant.
 */
export function normalizeEdit(item: Item, field: string, value: string, timeZone: string): { value: string } | { error: string } {
  if (!isEditField(field)) return { error: `${field} cannot be edited; the fields that can are ${EDIT_FIELDS.join(", ")}` };
  const v = collapseWhitespace(value);
  if ((field === "starts_at" || field === "location") && item.type !== "event") {
    return { error: `only an event has a ${EDIT_FIELD_LABEL[field]}` };
  }
  if ((field === "title" || field === "image") && !isManualItem(item)) {
    return { error: `the ${EDIT_FIELD_LABEL[field]} can only be changed on an event you added; this one comes from ${item.source}` };
  }
  switch (field) {
    case "title":
      if (!v) return { error: "The title cannot be empty." };
      if (v.length > EDIT_LIMITS.title) return { error: `Keep the title under ${EDIT_LIMITS.title} characters.` };
      return { value: v };
    case "image": {
      const img = checkImage(value);
      return "error" in img ? img : { value: img.ref };
    }
    case "summary":
      if (!v) return { error: "The description cannot be empty. To go back to the source's text, clear the edit instead." };
      if (v.length > EDIT_LIMITS.summary) return { error: `Keep the description under ${EDIT_LIMITS.summary} characters.` };
      return { value: v };
    case "location":
      if (!v) return { error: "The location cannot be empty. To go back to the source's text, clear the edit instead." };
      if (v.length > EDIT_LIMITS.location) return { error: `Keep the location under ${EDIT_LIMITS.location} characters.` };
      return { value: v };
    case "link": {
      // The same repair the add form makes, so a link fixed later is typed the same way.
      const link = normalizeLink(v);
      if (!isAbsoluteHttpUrl(link)) return { error: "Enter a full link starting with http:// or https://." };
      return { value: link };
    }
    case "starts_at": {
      const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(v);
      if (!m) return { error: "Give the date and time as YYYY-MM-DD HH:MM, for example 2026-10-22 19:00." };
      const [, y, mo, d, h, mi] = m.map(Number) as number[];
      const at = zonedToUtc(y!, mo!, d!, h!, mi!, 0, timeZone);
      // Reject impossible dates (2026-02-30) rather than let them roll into the next month.
      if (at.getTime() !== at.getTime() || !sameLocalParts(at, timeZone, y!, mo!, d!)) return { error: `${v.slice(0, 10)} is not a real date.` };
      return { value: at.toISOString() };
    }
  }
}

function sameLocalParts(at: Date, timeZone: string, y: number, mo: number, d: number): boolean {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
  return f === `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * Copies of `items` with the curator's edits applied. Items without edits are returned as they
 * are. `runAt` is when the run fetched the items: an event whose date is edited is past or
 * upcoming against that moment, as every other event was.
 */
export function applyEdits(items: Item[], edits: CuratorEdit[], runAt: Date): Item[] {
  const byItem = new Map<string, CuratorEdit[]>();
  for (const e of edits) {
    if (!isEditField(e.field)) continue;
    const list = byItem.get(e.item_id) ?? [];
    list.push(e);
    byItem.set(e.item_id, list);
  }
  return items.map((it) => {
    const mine = byItem.get(it.id);
    if (!mine?.length) return it;
    const copy: Item = { ...it };
    const fields: string[] = [];
    for (const e of mine) {
      switch (e.field as EditField) {
        case "title":
          if (!isManualItem(copy)) continue;
          copy.title = e.value;
          break;
        case "image":
          if (!isManualItem(copy)) continue;
          copy.image = e.value;
          break;
        case "summary":
          copy.summary = e.value;
          copy.needs_summary = false;
          // The curator's description replaces the points taken from the source, which would
          // otherwise be printed instead of it.
          delete copy.insights;
          break;
        case "location":
          if (copy.type !== "event") continue;
          copy.location = e.value;
          break;
        case "link":
          copy.link = e.value;
          break;
        case "starts_at":
          if (copy.type !== "event") continue;
          copy.date = e.value;
          copy.event_timing = Date.parse(e.value) < runAt.getTime() ? "past" : "upcoming";
          break;
      }
      fields.push(e.field);
    }
    // Always listed in the same order, however the edits were made.
    if (fields.length) copy.edited_fields = EDIT_FIELDS.filter((f) => fields.includes(f));
    return copy;
  });
}
