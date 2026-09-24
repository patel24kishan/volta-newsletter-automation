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
import { buildDrafts, type Draft, type DraftOptions } from "../draft/templates.js";
import { isManualItem, itemFromManualEvent, manualEventFromFields, MANUAL_REF_PREFIX, validateManualEvent, type ManualEventErrors, type ManualEventFields } from "../manual-events.js";
import { rankItems, type RankedItem } from "../pipeline/rank.js";
import type { Violation } from "../pipeline/verify.js";
import type { PublishedCampaign } from "../publish/types.js";
import { assertLive } from "../runtime.js";
import { isPastEvent, type Item } from "../schema.js";
import type { ReminderInput } from "../surface/blocks.js";
import type { SurfaceState } from "../surface/handlers.js";
import { persistSession, type DraftRecord } from "../surface/session.js";
import { checkImage, dataUri, isImageUrl, readLocalImage } from "../images.js";
import { applyEdits, EDIT_FIELD_LABEL, EDIT_FIELDS, isEditField, normalizeEdit, type EditField } from "./edits.js";

/** The review's state. The same shape the Slack surface uses, so both read one saved review. */
export type ReviewState = SurfaceState;

/** Where a review started outside Slack keeps its selection. */
export const CLAUDE_CHANNEL = "claude";

function now(st: ReviewState): Date {
  return st.now?.() ?? new Date();
}

/**
 * What every draft built from this review is told: the period it covers, so the subject can name
 * it, and the clock, so the newsletter splits held from upcoming exactly as the candidate list
 * does. Both builds here go through this, or the email rebuilt at Approve could disagree with the
 * one that was previewed.
 */
function draftOptions(st: ReviewState): Pick<DraftOptions, "timeZone" | "cadence" | "period" | "now"> {
  return {
    timeZone: st.timeZone,
    now: now(st),
    ...(st.cadence ? { cadence: st.cadence } : {}),
    ...(st.week ? { period: st.week } : {}),
  };
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

export function candidateGroups(st: Pick<ReviewState, "candidates"> & Partial<ReviewState>): CandidateGroups {
  const upcomingEvents: RankedItem[] = [];
  const pastEvents: RankedItem[] = [];
  const other: RankedItem[] = [];
  // Shown as the curator left them: an event whose date was edited moves to the group it now fits.
  const edited = withEdits(st as ReviewState, st.candidates.map((c) => c.item));
  for (const [i, c0] of st.candidates.entries()) {
    const c = edited[i] === c0.item ? c0 : { ...c0, item: edited[i]! };
    if (isPastEvent(c.item, st.now?.())) pastEvents.push(c);
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
  if (input.image !== undefined) {
    const img = checkImage(input.image);
    if ("error" in img) errors.image = img.error;
    else input.image = img.ref;
  }
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

/**
 * Forget an event the curator added. Only his own entries can go: everything else traces to a
 * source, and removing it there would be a lie about what was published.
 *
 * Without this the only way to correct an added event was to add it again, and two hand-added
 * events never merge (src/pipeline/dedupe.ts), so the newsletter printed both. The event leaves
 * storage, this period's candidates and the selection together, so nothing is left pointing at it.
 * Anything already approved or sent is untouched; this changes what the next draft is built from.
 */
export function removeEvent(st: ReviewState, itemId: string): { removed: Item } | { error: string } {
  if (!st.storage) throw new Error("events are not available: no storage for this review");
  const found = st.candidates.find((c) => c.item.id === itemId)?.item;
  if (!found) return { error: `${itemId} is not one of this period's candidates` };
  if (!isManualItem(found)) return { error: `${found.title} comes from ${found.source}, so it is not yours to remove. Untick it to leave it out.` };
  // As the curator last saw it. Removing is the one step he cannot undo, so the name he is shown
  // has to be the name he gave it, not the one it was stored under before he renamed it.
  const removed = withEdits(st, [found])[0] ?? found;

  st.storage.deleteManualEvent(found.source_ref.slice(MANUAL_REF_PREFIX.length));
  // His wording goes with the item it described. Left behind it would never be applied again (the
  // item is gone), but it would sit in storage for good, and a returning id would revive it.
  if (st.edits && st.week) st.edits.clearCuratorEdits(st.week, itemId);
  st.candidates = st.candidates.filter((c) => c.item.id !== itemId);
  for (const [channel, ids] of st.selections) st.selections.set(channel, ids.filter((id) => id !== itemId));

  const r = st.reminder;
  if (r) {
    st.reminder = { ...r, input: { ...r.input, candidates: st.candidates, preselectedIds: currentSelection(st) } };
  }
  persistSession(st);
  return { removed };
}

/** The run's time: what past and upcoming were decided against. */
function runAt(st: ReviewState): Date {
  const sent = st.reminder?.sentAt ? new Date(st.reminder.sentAt) : undefined;
  return sent && !Number.isNaN(sent.getTime()) ? sent : now(st);
}

/** Items as the curator has worded them for this period. Unchanged when nothing was edited. */
function withEdits(st: ReviewState, items: Item[]): Item[] {
  if (!st.edits || !st.week) return items;
  return applyEdits(items, st.edits.listCuratorEdits(st.week), runAt(st));
}

export type EditResult = { item: Item } | { error: string };

/**
 * Save the curator's wording for one field of a candidate, or clear it (`value` null) to go back to
 * the source's text. Takes the curator's exact words: nothing here writes text of its own. Saved
 * for the period and applied to every later build, whatever is ticked.
 */
export function editItem(st: ReviewState, itemId: string, field: string, value: string | null): EditResult {
  if (!st.edits || !st.week) throw new Error("edits are not available: no storage for this review");
  const candidate = st.candidates.find((c) => c.item.id === itemId)?.item;
  if (!candidate) return { error: `${itemId} is not one of this period's candidates` };
  if (!isEditField(field)) return { error: `${field} cannot be edited; the fields that can are ${EDIT_FIELDS.join(", ")}` };
  if (value === null) {
    st.edits.setCuratorEdit(st.week, itemId, field, null, now(st).toISOString());
  } else {
    const n = normalizeEdit(candidate, field, value, st.timeZone);
    if ("error" in n) return n;
    st.edits.setCuratorEdit(st.week, itemId, field, n.value, now(st).toISOString());
  }
  return { item: withEdits(st, [candidate])[0]! };
}

/** What the curator should know about the picked items that the newsletter itself will not say. */
export interface DraftNotes {
  held: Array<{ id: string; title: string; hold_note?: string }>;
  editorNotes: Array<{ id: string; title: string; notes: string[] }>;
  /** Items whose wording the curator changed, and which parts, so no rewording is silent. */
  edited: Array<{ id: string; title: string; fields: string[] }>;
}

export function notesFor(items: Item[]): DraftNotes {
  return {
    held: items.filter((i) => i.requires_review).map((i) => ({ id: i.id, title: i.title, ...(i.hold_note ? { hold_note: i.hold_note } : {}) })),
    editorNotes: items.filter((i) => i.editor_notes?.length).map((i) => ({ id: i.id, title: i.title, notes: i.editor_notes! })),
    edited: items.filter((i) => i.edited_fields?.length).map((i) => ({ id: i.id, title: i.title, fields: i.edited_fields!.map((f) => (isEditField(f) ? EDIT_FIELD_LABEL[f as EditField] : f)) })),
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
  const items = withEdits(st, ids.map((id) => byId.get(id)).filter((x): x is Item => Boolean(x)));
  const notes = notesFor(items);
  if (items.length === 0) return { ok: false, reason: "nothing-selected", notes };

  // The preview shows a local image inline; the email gets a hosted copy at Approve.
  const drafts = buildDrafts(items, { ...draftOptions(st), layouts: [st.layout ?? "events-first"], imageSrc: previewImage });
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

/** An image for the preview: an https link as it is, a local file inline; left out if the file has gone. */
function previewImage(ref: string): string | undefined {
  if (isImageUrl(ref)) return ref;
  try {
    return dataUri(readLocalImage(ref));
  } catch {
    return undefined;
  }
}

/**
 * The email as it will be sent: the approved draft rebuilt with every local image replaced by the
 * platform's hosted copy, uploaded now. Nothing else changes, since the same items give the same
 * text. A local image that cannot be uploaded (no upload on this platform) is left out rather
 * than pointing subscribers at a file on the curator's computer.
 */
async function emailDraft(st: ReviewState, record: DraftRecord): Promise<Draft> {
  const local = [...new Set(record.items.map((i) => i.image).filter((r): r is string => Boolean(r) && !isImageUrl(r!)))];
  if (local.length === 0) return record.draft;
  const hosted = new Map<string, string>();
  const upload = st.publisher?.uploadImage?.bind(st.publisher);
  if (upload) for (const ref of local) hosted.set(ref, await upload(readLocalImage(ref)));
  const [d] = buildDrafts(record.items, {
    ...draftOptions(st), layouts: [record.draft.id],
    imageSrc: (ref) => (isImageUrl(ref) ? ref : hosted.get(ref)),
  });
  return { ...record.draft, html: d!.html };
}

/**
 * The campaign an earlier approval created for this period, if any: the latest one, and whether it
 * has been sent. Campaigns recorded before periods were kept have none, and are never matched.
 */
function periodCampaign(st: ReviewState): { id: string; editUrl: string; sent: boolean } | undefined {
  if (!st.week || !st.session?.listCampaigns) return undefined;
  const mine = st.session.listCampaigns().filter((c) => c.period === st.week);
  const sent = mine.find((c) => c.sent_at !== null || st.sent?.has(c.id));
  const pick = sent ?? mine.at(-1);
  return pick ? { id: pick.id, editUrl: pick.edit_url ?? "", sent: Boolean(sent) } : undefined;
}

/** The draft waiting for approval, if any. */
export function currentDraft(st: ReviewState): DraftRecord | undefined {
  return [...st.drafts.values()].at(-1);
}

export interface SavedFiles { html: string; md: string }

export type ApproveResult =
  | { status: "missing" }
  | { status: "saved"; draft: Draft; files: SavedFiles; held: Item[] }
  | { status: "created" | "already" | "updated"; draft: Draft; files: SavedFiles; held: Item[]; campaign: { id: string; editUrl: string; platform: string }; audience: { audienceName: string; memberCount: number } }
  /** This period's newsletter already went out: a changed draft is saved locally but not applied. */
  | { status: "period-sent"; draft: Draft; files: SavedFiles; held: Item[]; campaignId: string }
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
  // A newsletter changed after it was approved stays one campaign: the period's draft campaign is
  // updated in place. Once that campaign has been sent, the month is done and nothing is changed.
  const earlier = periodCampaign(st);
  if (earlier?.sent) return { status: "period-sent", draft: d, files, held, campaignId: earlier.id };
  if (earlier && st.publisher.updateDraft) {
    const campaign = { id: earlier.id, editUrl: earlier.editUrl, platform: st.publisher.platform };
    try {
      const email = await emailDraft(st, record);
      writeFileSync(files.html, email.html, "utf8");
      await st.publisher.updateDraft(earlier.id, email);
    } catch (e) {
      return { status: "failed", draft: d, files, held, platform: st.publisher.platform, error: e as Error };
    }
    record.campaign = campaign;
    persistSession(st);
    return { status: "updated", draft: d, files, held, campaign, audience };
  }
  let c: PublishedCampaign;
  try {
    const email = await emailDraft(st, record);
    // What is saved locally matches what the platform received.
    writeFileSync(files.html, email.html, "utf8");
    c = await st.publisher.publishDraft(email);
  } catch (e) {
    return { status: "failed", draft: d, files, held, platform: st.publisher.platform, error: e as Error };
  }
  // Remembered before anything else can fail: a campaign the app forgot it created could never
  // be sent from here, and would sit in the email platform with nobody knowing why.
  record.campaign = { id: c.id, editUrl: c.editUrl, platform: c.platform };
  st.campaigns.add(c.id);
  st.session?.recordCampaign(c.id, record.key, st.week, c.editUrl);
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
