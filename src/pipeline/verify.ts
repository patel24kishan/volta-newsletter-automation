/**
 * No-fabrication verifier (constraint 5). Runs on every generated draft.
 * A draft passes only if every link, named entity, calendar date and clock time it contains can be
 * found in the selected items' retrieved text (or in the template's own fixed phrases, passed as
 * an allowlist). Anything else is a violation, and the draft is not shown to Bader.
 *
 * Entity detection is deliberately conservative: multi-word capitalized phrases anywhere, and single
 * capitalized words that are not at the start of a sentence. Template headings are allowlisted.
 */
import { partsInZone } from "../clock.js";
import type { Item } from "../schema.js";
import { normalizeUrl } from "./dedupe.js";

export interface Violation {
  kind: "link" | "entity" | "date" | "time";
  value: string;
  /** A few words around the value in the draft. */
  context: string;
}

export interface VerifyResult {
  ok: boolean;
  violations: Violation[];
  checked: { links: number; entities: number; dates: number; times: number };
}

export interface VerifyOptions {
  timeZone: string;
  /** Fixed phrases the template itself contributes (headings, footer). Case-insensitive. */
  allow?: string[];
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const JOINERS = new Set(["of", "and", "the", "for", "de", "&", "-", "–", "—"]);

export function verifyDraft(draft: string, items: Item[], opts: VerifyOptions): VerifyResult {
  const corpus = buildCorpus(items);
  const allow = new Set((opts.allow ?? []).map((s) => s.toLowerCase()));
  const violations: Violation[] = [];
  const checked = { links: 0, entities: 0, dates: 0, times: 0 };

  // 1. Links
  const allowedLinks = new Set<string>();
  for (const it of items) {
    allowedLinks.add(normalizeUrl(it.link));
    for (const r of it.related ?? []) allowedLinks.add(normalizeUrl(r.link));
  }
  for (const m of draft.matchAll(/https?:\/\/[^\s)<>"'\]]+/g)) {
    checked.links++;
    const url = m[0].replace(/[.,;:!?]+$/, "");
    if (!allowedLinks.has(normalizeUrl(url))) violations.push({ kind: "link", value: url, context: around(draft, m.index ?? 0) });
  }

  // 2. Dates and times (collected first so they are not re-flagged as entities)
  const allowedDates = new Set<string>();
  const allowedTimes = new Set<string>();
  for (const it of items) {
    const p = partsInZone(new Date(it.date), opts.timeZone);
    allowedDates.add(`${p.month}-${p.day}`);
    allowedDates.add(`${p.year}-${p.month}-${p.day}`);
    const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
    allowedTimes.add(`${h12}:${String(p.minute).padStart(2, "0")}${p.hour < 12 ? "am" : "pm"}`);
  }
  // Dates and times written in the items' own text are evidence too (a post saying "October 1").
  const rawText = items.map((it) => `${it.title} ${it.summary} ${it.raw_excerpt}`).join(" \n ");
  for (const m of rawText.matchAll(dateRe())) allowedDates.add(dateKey(m));
  for (const m of rawText.matchAll(TIME_RE)) allowedTimes.add(timeKey(m));

  const dateSpans: Array<[number, number]> = [];
  for (const m of draft.matchAll(dateRe())) {
    checked.dates++;
    dateSpans.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
    if (!allowedDates.has(dateKey(m))) violations.push({ kind: "date", value: m[0], context: around(draft, m.index ?? 0) });
  }
  for (const m of draft.matchAll(TIME_RE)) {
    checked.times++;
    if (!allowedTimes.has(timeKey(m))) violations.push({ kind: "time", value: m[0], context: around(draft, m.index ?? 0) });
  }

  // 3. Entities. URLs and tags are blanked with same-length spaces so offsets still line up with dateSpans.
  const blank = (m: string) => " ".repeat(m.length);
  const text = draft.replace(/https?:\/\/[^\s)<>"'\]]+/g, blank).replace(/<[^>]+>/g, blank);
  // An entity is fine if it is part of any allowlisted template phrase ("Bader" in the footer line).
  const allowText = norm([...allow].join(" \n "));
  for (const phrase of extractEntities(text, dateSpans)) {
    const n = norm(phrase.value);
    if (allowText.includes(n) || MONTHS.includes(n) || WEEKDAYS.includes(n)) continue;
    checked.entities++;
    if (!corpus.includes(n)) violations.push({ kind: "entity", value: phrase.value, context: around(draft, phrase.index) });
  }

  return { ok: violations.length === 0, violations, checked };
}

export function buildCorpus(items: Item[]): string {
  const parts: string[] = [];
  for (const it of items) {
    parts.push(it.title, it.summary, it.raw_excerpt, it.location ?? "", it.byline ?? "", ...(it.insights ?? []));
    for (const r of it.related ?? []) parts.push(r.title);
  }
  return norm(parts.join(" \n "));
}

/** Case, punctuation and whitespace are not evidence of fabrication; compare letters and digits only. */
export function norm(s: string): string {
  return s.toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

interface Phrase { value: string; index: number }

/**
 * Capitalized phrases. A sentence-initial capitalized word is ordinary English ("Join", "This"), so it
 * is dropped from the front of a phrase; whatever remains is checked. Positions inside date spans
 * are skipped so "September" never counts as a name.
 */
export function extractEntities(text: string, skipSpans: Array<[number, number]>): Phrase[] {
  const out: Phrase[] = [];
  const wordRe = /[A-Za-z][A-Za-z0-9’'-]*|&|[–—-]|[.!?\n]+|[,;:()"“”[\]|]/g;
  const tokens: { t: string; i: number }[] = [];
  for (const m of text.matchAll(wordRe)) tokens.push({ t: m[0], i: m.index ?? 0 });

  let sentenceStart = true;
  let k = 0;
  while (k < tokens.length) {
    const tok = tokens[k]!;
    if (/^[.!?\n]+$/.test(tok.t)) { sentenceStart = true; k++; continue; }
    // An opening bracket or parenthesis starts a label ("[Also covered: ...]"), whose first word is ordinary.
    if (/^[([]$/.test(tok.t)) { sentenceStart = true; k++; continue; }
    if (/^[,;:)"“”\]|]$/.test(tok.t)) { k++; continue; }
    if (isCap(tok.t) && !inSpan(tok.i, skipSpans)) {
      let j = k + 1;
      while (j < tokens.length) {
        const nt = tokens[j]!;
        if (isCap(nt.t) && !inSpan(nt.i, skipSpans)) { j++; continue; }
        if (JOINERS.has(nt.t.toLowerCase()) && j + 1 < tokens.length && isCap(tokens[j + 1]!.t) && !inSpan(tokens[j + 1]!.i, skipSpans)) { j++; continue; }
        break;
      }
      let phrase = tokens.slice(k, j);
      if (sentenceStart) phrase = phrase.slice(1);
      while (phrase.length && JOINERS.has(phrase[0]!.t.toLowerCase())) phrase = phrase.slice(1);
      if (phrase.length) {
        const value = phrase.map((x) => x.t).join(" ");
        if (value.replace(/[^A-Za-z]/g, "").length >= 3) out.push({ value, index: phrase[0]!.i });
      }
      k = j;
      sentenceStart = false;
      continue;
    }
    sentenceStart = false;
    k++;
  }
  return out;
}

/** A token that could be part of a proper name: starts uppercase, at least two characters, not a lone article or pronoun. */
function isCap(t: string): boolean {
  return /^[A-Z][A-Za-z0-9’'.-]+$/.test(t) && !/^(An|I)$/.test(t);
}

function inSpan(i: number, spans: Array<[number, number]>): boolean {
  return spans.some(([a, b]) => i >= a && i < b);
}

const MONTH_ALT = MONTHS.map((m) => `${m.slice(0, 3)}[a-z]*\\.?`).join("|");
/** "September 24", "Sept. 24th, 2026", "24 September", "2026-09-24". Fresh regex each call (global state). */
function dateRe(): RegExp {
  return new RegExp(`\\b(${MONTH_ALT})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,\\s*(\\d{4}))?\\b|\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_ALT})(?:,?\\s*(\\d{4}))?\\b|\\b(\\d{4})-(\\d{2})-(\\d{2})\\b`, "gi");
}
const TIME_RE = /\b(\d{1,2}):(\d{2})\s?(am|pm|a\.m\.|p\.m\.)\b/gi;

function dateKey(m: RegExpMatchArray): string {
  let month: number, day: number, year: string | undefined;
  if (m[1]) { month = monthIndex(m[1]); day = Number(m[2]); year = m[3]; }
  else if (m[5]) { month = monthIndex(m[5]); day = Number(m[4]); year = m[6]; }
  else { month = Number(m[8]); day = Number(m[9]); year = m[7]; }
  return year ? `${year}-${month}-${day}` : `${month}-${day}`;
}

function timeKey(m: RegExpMatchArray): string {
  return `${Number(m[1])}:${m[2]}${(m[3] ?? "").replace(/\./g, "").toLowerCase()}`;
}

function monthIndex(s: string): number {
  const p = s.toLowerCase().slice(0, 3);
  return MONTHS.findIndex((m) => m.startsWith(p)) + 1;
}

function around(text: string, i: number): string {
  return text.slice(Math.max(0, i - 30), i + 40).replace(/\s+/g, " ").trim();
}
