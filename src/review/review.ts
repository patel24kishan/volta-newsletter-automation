/**
 * The review of one newsletter (a week's or a month's), with no chat surface in it. Each step
 * changes the review and returns what happened; showing it is the caller's job, whether that is
 * Slack buttons or tools Claude calls.
 *
 * Nothing here takes newsletter text: a draft is built from item ids, approved by its key and
 * sent by its campaign id, so whoever drives these steps cannot put words in the email.
 * Only the steps that reach the email platform check ALLOW_LIVE (CLAUDE.md section 4); building
 * a draft and saving it locally are safe in dry-run.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Alerter } from "../alerts.js";
import { buildDrafts, type Draft } from "../draft/templates.js";
import { itemFromManualEvent, manualEventFromFields, validateManualEvent, type ManualEventErrors, type ManualEventFields } from "../manual-events.js";
import { rankItems, type RankedItem } from "../pipeline/rank.js";
import type { Violation } from "../pipeline/verify.js";
import type { PublishedCampaign } from "../publish/types.js";
import { assertLive } from "../runtime.js";
import { isPastEvent, type Item } from "../schema.js";
import type { ReminderInput } from "../surface/blocks.js";
import type { SurfaceState } from "../surface/handlers.js";
import { persistSession, type DraftRecord } from "../surface/session.js";

/** The review's state. The same shape the Slack surface uses, so both read one saved review. */
export type ReviewState = SurfaceState;

/** Where a review started outside Slack keeps its selection. */
export const CLAUDE_CHANNEL = "claude";

function now(st: ReviewState): Date {
  return st.now?.() ?? new Date();
}

/** The channel whose ticks count: the list's, or Claude's when no Slack list was posted. */
function selectionKey(st: ReviewState): string {
  return st.reminder?.channel ?? CLAUDE_CHANNEL;
}

/**
 * Begin the period's review from a finished run: the candidates, with the pre-ticked ones as the
 * selection. Saved at once under the run's period (the month, when monthly), so a new chat or a
 * restart later in the month finds it.
 */
export function startReview(st: ReviewState, input: ReminderInput, channel = CLAUDE_CHANNEL): void {
  st.candidates = input.candidates;
  st.reminder = { input, channel, sentAt: now(st).toISOString() };
  st.selections.set(channel, input.preselectedIds);
  st.week ??= input.period ?? input.firstWorkday.weekMonday;
  persistSession(st);
}

/**
 * The candidates as the curator reads them: events still to come (soonest first), events already
 * held last month (most recent first), and everything else in rank order. Past and upcoming are
 * never mixed, here or in the newsletter.
 */
export interface CandidateGroups {
  upcomingEvents: RankedItem[];
  pastEvents: RankedItem[];
  other: RankedItem[];
}

export function candidateGroups(st: Pick<ReviewState, "candidates">): CandidateGroups {
  const upcomingEvents: RankedItem[] = [];
  const pastEvents: RankedItem[] = [];
  const other: RankedItem[] = [];
  for (const c of st.candidates) {
    if (isPastEvent(c.item)) pastEvents.push(c);
    else if (c.item.type === "event") upcomingEvents.push(c);
    else other.push(c);
  }
  upcomingEvents.sort((a, b) => a.item.date.localeCompare(b.item.date));
  pastEvents.sort((a, b) => b.item.date.localeCompare(a.item.date));
  return { upcomingEvents, pastEvents, other };
}

/** The ids ticked now, in candidate order. */
export function currentSelection(st: ReviewState): string[] {
  return st.selections.get(selectionKey(st)) ?? st.reminder?.input.preselectedIds ?? [];
}

/**
 * Replace the selection. Ids that are not candidates are reported, not kept, so a mistyped or
 * stale id cannot quietly shrink the newsletter.
 */
export function setSelection(st: ReviewState, ids: string[]): { selected: string[]; unknown: string[] } {
  const known = new Set(st.candidates.map((c) => c.item.id));
  const unique = [...new Set(ids)];
  const selected = unique.filter((id) => known.has(id));
  const unknown = unique.filter((id) => !known.has(id));
  st.selections.set(selectionKey(st), selected);
  persistSession(st);
  return { selected, unknown };
}

/**
 * Add an event the curator knows about that no source lists. It is stored, so it survives a
 * restart and reappears on the next run, and joins the selection already ticked: adding it is the
 * decision. Nothing is invented on the curator's behalf.
 */
export function addEvent(st: ReviewState, fields: ManualEventFields): { item: Item } | { errors: ManualEventErrors } {
  if (!st.storage || !st.manualSource) throw new Error("no manual events source is configured, so an event cannot be added");
  const input = manualEventFromFields(fields, st.timeZone);
  const errors = validateManualEvent(input, now(st));
  if (Object.keys(errors).length) return { errors };

  const saved = st.storage.addManualEvent(input);
  const item = itemFromManualEvent(saved, st.manualSource, st.manualSource.fallback_link);
  item.event_timing = "upcoming"; // the form only takes a start in the future
  st.candidates = rankItems([...st.candidates.map((c) => c.item), item], now(st));

  const r = st.reminder;
  if (!r) return { item };
  const ticked = [...new Set([...currentSelection(st), item.id])];
  st.reminder = { ...r, input: { ...r.input, candidates: st.candidates, preselectedIds: ticked } };
  st.selections.set(r.channel, ticked);
  persistSession(st);
  return { item };
}

/** What the curator should know about the picked items that the newsletter itself will not say. */
export interface DraftNotes {
  held: Array<{ id: string; title: string; hold_note?: string }>;
  editorNotes: Array<{ id: string; title: string; notes: string[] }>;
}

export function notesFor(items: Item[]): DraftNotes {
  return {
    held: items.filter((i) => i.requires_review).map((i) => ({ id: i.id, title: i.title, ...(i.hold_note ? { hold_note: i.hold_note } : {}) })),
    editorNotes: items.filter((i) => i.editor_notes?.length).map((i) => ({ id: i.id, title: i.title, notes: i.editor_notes! })),
  };
}

export type BuildResult =
  | { ok: true; key: string; draft: Draft; items: Item[]; previewUrl?: string; notes: DraftNotes }
  | { ok: false; reason: "nothing-selected"; notes: DraftNotes }
  | { ok: false; reason: "not-verified"; violations: Violation[]; items: Item[]; notes: DraftNotes };

/**
 * Build the newsletter from the given ids (the current selection when omitted) and verify
 * it. Only the newest draft is kept, so an Approve left over from an earlier one finds nothing; a
 * draft that fails verification is never kept, and the previous one stays exactly as it was.
 */
export function buildDraft(st: ReviewState, alerter: Alerter, ids: string[] = currentSelection(st)): BuildResult {
  const byId = new Map(st.candidates.map((c) => [c.item.id, c.item] as const));
  const items = ids.map((id) => byId.get(id)).filter((x): x is Item => Boolean(x));
  const notes = notesFor(items);
  if (items.length === 0) return { ok: false, reason: "nothing-selected", notes };

  const drafts = buildDrafts(items, { timeZone: st.timeZone, layouts: [st.layout ?? "events-first"], ...(st.cadence ? { cadence: st.cadence } : {}) });
  for (const d of drafts.filter((d) => !d.verification.ok)) {
    alerter.alert("error", `draft:${d.id}`, `withheld: ${d.verification.violations.map((v) => `${v.kind} "${v.value}"`).join(", ")}`, "inspect the items; the draft was not shown");
  }
  const d = drafts.find((x) => x.verification.ok);
  if (!d) return { ok: false, reason: "not-verified", violations: drafts.flatMap((x) => x.verification.violations), items, notes };

  const key = randomUUID();
  const previewId = st.preview ? randomUUID() : undefined;
  const previewUrl = previewId ? st.preview!.put(d.html, previewId) : undefined;
  st.drafts.clear();
  st.drafts.set(key, { key, draft: d, items, ...(previewId ? { previewId } : {}) });
  persistSession(st);
  return { ok: true, key, draft: d, items, ...(previewUrl ? { previewUrl } : {}), notes };
}

/** The draft waiting for approval, if any. */
export function currentDraft(st: ReviewState): DraftRecord | undefined {
  return [...st.drafts.values()].at(-1);
}

export interface SavedFiles { html: string; md: string }

export type ApproveResult =
  | { status: "missing" }
  | { status: "saved"; draft: Draft; files: SavedFiles; held: Item[] }
  | { status: "created" | "already"; draft: Draft; files: SavedFiles; held: Item[]; campaign: { id: string; editUrl: string; platform: string }; audience: { audienceName: string; memberCount: number } }
  | { status: "failed"; draft: Draft; files: SavedFiles; held: Item[]; platform: string; error: Error };

/**
 * Approve a draft by its key. It is always saved to the output folder; with an email platform
 * configured, a draft campaign is created there too (live only). Approving the same draft again
 * returns the campaign already made rather than creating a second.
 */
export async function approve(st: ReviewState, key: string): Promise<ApproveResult> {
  const record = st.drafts.get(key);
  if (!record) return { status: "missing" };
  const d = record.draft;
  mkdirSync(st.outDir, { recursive: true });
  const files = { html: join(st.outDir, "final.html"), md: join(st.outDir, "final.md") };
  writeFileSync(files.html, d.html, "utf8");
  writeFileSync(files.md, d.markdown, "utf8");
  // From what the draft was built from, so the warning survives a restart and a fresh fetch.
  const held = record.items.filter((i) => i.requires_review);

  if (!st.publisher) return { status: "saved", draft: d, files, held };
  const audience = st.audience ?? { audienceName: "audience", memberCount: 0 };
  if (record.campaign) return { status: "already", draft: d, files, held, campaign: record.campaign, audience };

  assertLive(`create the ${st.publisher.platform} campaign`, st.env);
  let c: PublishedCampaign;
  try {
    c = await st.publisher.publishDraft(d);
  } catch (e) {
    return { status: "failed", draft: d, files, held, platform: st.publisher.platform, error: e as Error };
  }
  // Remembered before anything else can fail: a campaign the app forgot it created could never
  // be sent from here, and would sit in the email platform with nobody knowing why.
  record.campaign = { id: c.id, editUrl: c.editUrl, platform: c.platform };
  st.campaigns.add(c.id);
  st.session?.recordCampaign(c.id, record.key);
  persistSession(st);
  return { status: "created", draft: d, files, held, campaign: record.campaign, audience };
}

export type SendResult = { status: "sent"; platform: string } | { status: "no-platform" | "already-sent" | "unknown" };

/** Send a campaign Approve created. Refused if it was already sent or was not made here. */
export async function send(st: ReviewState, campaignId: string): Promise<SendResult> {
  assertLive("send the email campaign", st.env);
  if (!st.publisher) return { status: "no-platform" };
  if (st.sent?.has(campaignId)) return { status: "already-sent" };
  if (!st.campaigns.has(campaignId)) return { status: "unknown" };
  await st.publisher.send(campaignId);
  // Recorded as soon as it has gone, so a second request is refused.
  st.campaigns.delete(campaignId);
  (st.sent ??= new Set()).add(campaignId);
  st.session?.markCampaignSent(campaignId);
  return { status: "sent", platform: st.publisher.platform };
}
