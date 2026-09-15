/**
 * iCalendar (ICS) fetcher. Demo source: Volta's public calendar feed.
 * Keeps events that start between now and now + events_window_days. Cancelled events are dropped.
 * Link is the event URL; when absent, the source's fallback_link (Volta's events page) is used
 * with medium confidence, and the event is skipped if there is no fallback either (constraint 5).
 */
import type { SourceConfig } from "../config.js";
import { fetchText as defaultFetchText } from "../http.js";
import { isAbsoluteHttpUrl, itemId, type Item } from "../schema.js";
import { collapseWhitespace, firstSentences } from "../text.js";
import type { FetchContext, FetchResult, Fetcher } from "./types.js";

export interface IcsProperty {
  name: string;
  params: Record<string, string>;
  value: string;
}
export type IcsEvent = Record<string, IcsProperty>;

export class IcsFetcher implements Fetcher {
  readonly kind = "ics" as const;

  async fetch(source: SourceConfig, ctx: FetchContext): Promise<FetchResult> {
    const get = ctx.fetchText ?? defaultFetchText;
    let body: string;
    try {
      body = await get(source.url);
    } catch (e) {
      return { source: source.id, items: [], warnings: [], error: (e as Error).message, bytes: 0 };
    }
    const parsed = parseIcs(body);
    if ("error" in parsed) return { source: source.id, items: [], warnings: [], error: parsed.error, bytes: body.length };

    const now = ctx.clock.now();
    const until = new Date(now.getTime() + ctx.config.events_window_days * 86_400_000);
    const tz = ctx.config.timezone;
    const warnings: string[] = [];
    const items: Item[] = [];
    let outside = 0;
    let cancelled = 0;

    for (const ev of parsed.events) {
      const title = ev.SUMMARY?.value ?? "";
      const uid = ev.UID?.value ?? "";
      const start = ev.DTSTART ? parseIcsDate(ev.DTSTART, tz) : undefined;
      if (!title || !uid) {
        warnings.push(`skipped event without SUMMARY or UID`);
        continue;
      }
      if (!start) {
        warnings.push(`skipped event with unparseable DTSTART: "${title}"`);
        continue;
      }
      if ((ev.STATUS?.value ?? "").toUpperCase() === "CANCELLED") {
        cancelled++;
        continue;
      }
      if (start < now || start > until) {
        outside++;
        continue;
      }

      let link = ev.URL?.value ?? "";
      let confidence: Item["confidence"] = "high";
      if (!isAbsoluteHttpUrl(link)) {
        if (source.fallback_link && isAbsoluteHttpUrl(source.fallback_link)) {
          link = source.fallback_link;
          confidence = "medium";
          warnings.push(`event has no URL, linked to fallback: "${title}"`);
        } else {
          warnings.push(`skipped event without URL and no fallback_link configured: "${title}"`);
          continue;
        }
      }

      const description = collapseWhitespace(ev.DESCRIPTION?.value ?? "");
      const location = collapseWhitespace(ev.LOCATION?.value ?? "");
      const summary = firstSentences(description, 2, 280);
      const item: Item = {
        id: itemId(source.id, `${uid}@${link}`),
        source: source.id,
        type: source.type,
        date: start.toISOString(),
        title,
        summary,
        needs_summary: summary === "",
        link,
        source_ref: uid,
        confidence,
        requires_review: false,
        raw_excerpt: collapseWhitespace([title, location ? `Location: ${location}.` : "", description].filter(Boolean).join(" ")),
      };
      if (location) item.location = location;
      items.push(item);
    }

    items.sort((a, b) => a.date.localeCompare(b.date));
    if (outside) warnings.push(`${outside} event(s) outside the next ${ctx.config.events_window_days} days`);
    if (cancelled) warnings.push(`${cancelled} cancelled event(s) dropped`);
    return { source: source.id, items, warnings, bytes: body.length };
  }
}

export function parseIcs(body: string): { events: IcsEvent[]; calendarName: string } | { error: string } {
  if (!body || body.trim() === "") return { error: "empty response body" };
  const lines = unfold(body);
  if (!lines.some((l) => /^BEGIN:VCALENDAR/i.test(l))) return { error: "no BEGIN:VCALENDAR; not an iCalendar feed" };

  const events: IcsEvent[] = [];
  let calendarName = "";
  let current: IcsEvent | undefined;
  let depth = 0; // nesting inside VEVENT (VALARM etc.) is ignored

  for (const line of lines) {
    const prop = parseProperty(line);
    if (!prop) continue;
    if (prop.name === "BEGIN") {
      if (prop.value.toUpperCase() === "VEVENT" && !current) current = {};
      else if (current) depth++;
      continue;
    }
    if (prop.name === "END") {
      if (current && depth > 0) depth--;
      else if (current && prop.value.toUpperCase() === "VEVENT") {
        events.push(current);
        current = undefined;
      }
      continue;
    }
    if (current && depth === 0) {
      if (!(prop.name in current)) current[prop.name] = prop;
    } else if (!current && prop.name === "X-WR-CALNAME") {
      calendarName = prop.value;
    }
  }
  return { events, calendarName };
}

/** RFC 5545 line unfolding: CRLF or LF followed by a space or tab continues the previous line. */
export function unfold(body: string): string[] {
  return body.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n");
}

export function parseProperty(line: string): IcsProperty | undefined {
  const colon = findValueColon(line);
  if (colon < 0) return undefined;
  const head = line.slice(0, colon);
  const rawValue = line.slice(colon + 1);
  const [name = "", ...paramParts] = head.split(";");
  const params: Record<string, string> = {};
  for (const p of paramParts) {
    const eq = p.indexOf("=");
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: name.toUpperCase(), params, value: unescapeText(rawValue) };
}

/** The value starts at the first colon not inside a quoted parameter value. */
function findValueColon(line: string): number {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === ":" && !quoted) return i;
  }
  return -1;
}

function unescapeText(s: string): string {
  return s.replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
}

/**
 * DTSTART forms: 20260916T210000Z (UTC), 20260916T180000 with TZID or floating, 20260916 (all-day).
 * Floating and TZID values are interpreted in the configured timezone; a TZID that differs from it
 * is still interpreted in the configured zone (the demo feed is pure UTC, so this path is rare).
 */
export function parseIcsDate(prop: IcsProperty, timeZone: string): Date | undefined {
  const v = prop.value.trim();
  const isDate = prop.params.VALUE === "DATE" || /^\d{8}$/.test(v);
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(v);
  if (!m) return undefined;
  const [, Y, M, D, h = "00", mi = "00", s = "00", z] = m;
  const y = Number(Y), mo = Number(M), d = Number(D), hh = Number(h), mm = Number(mi), ss = Number(s);
  if (z && !isDate) return new Date(Date.UTC(y, mo - 1, d, hh, mm, ss));
  return zonedToUtc(y, mo, d, isDate ? 0 : hh, isDate ? 0 : mm, isDate ? 0 : ss, timeZone);
}

/** Convert wall-clock parts in a zone to a UTC instant using Intl (two-pass offset correction). */
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, timeZone: string): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const offset1 = offsetMs(new Date(guess), timeZone);
  const candidate = guess - offset1;
  const offset2 = offsetMs(new Date(candidate), timeZone);
  return new Date(guess - offset2);
}

function offsetMs(d: Date, timeZone: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return asUtc - d.getTime();
}
