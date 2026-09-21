/**
 * The Slack review as it stands, saved so a restart does not lose it. Once hosted, the app
 * restarts on every deploy, crash and host reboot; without this, a restart between Generate and
 * Approve, or Approve and Send, would leave Bader pressing buttons the app no longer recognises.
 *
 * What is saved is an explicit list of fields, never the whole state object: that object holds
 * the Slack and Mailchimp tokens in `env`, which must never reach the database.
 */
import type { Draft } from "../draft/templates.js";
import type { Item } from "../schema.js";
import type { Storage } from "../storage.js";
import type { ReminderInput } from "./blocks.js";
import type { SurfaceState } from "./handlers.js";

/** Bumped whenever the saved shape changes, so an older snapshot is set aside rather than misread. */
export const SESSION_VERSION = 1;

/**
 * One generated newsletter. `key` is new for every generation and is what its Approve button
 * carries, so a button from an earlier generation cannot approve a later draft. `items` are the
 * ones it was built from, so the warning about held items before Send reflects what is in it.
 */
export interface DraftRecord {
  key: string;
  draft: Draft;
  items: Item[];
  /** Where its preview is served, so the link Bader already has survives a restart. */
  previewId?: string;
  /** The campaign Approve created for it, so approving it again cannot create a second one. */
  campaign?: { id: string; editUrl: string; platform: string };
}

export interface SessionSnapshot {
  v: typeof SESSION_VERSION;
  reminder: { input: ReminderInput; channel: string; ts?: string; sentAt: string };
  selections: Record<string, string[]>;
  drafts: DraftRecord[];
  postedDraft?: { key: string; channel: string; ts?: string };
}

/** What a restart needs; undefined until a reminder has been sent, since nothing precedes it. */
export function snapshotOf(st: SurfaceState): SessionSnapshot | undefined {
  const r = st.reminder;
  if (!r?.sentAt) return undefined;
  return {
    v: SESSION_VERSION,
    reminder: { input: r.input, channel: r.channel, ...(r.ts ? { ts: r.ts } : {}), sentAt: r.sentAt },
    selections: Object.fromEntries(st.selections),
    drafts: [...st.drafts.values()],
    ...(st.postedDraft ? { postedDraft: st.postedDraft } : {}),
  };
}

/**
 * Save now. Called straight after each change rather than at the end of a handler, because a
 * handler can change state and then fail on a Slack or Mailchimp call before it would return.
 */
export function persistSession(st: SurfaceState): void {
  if (!st.session || !st.week) return;
  const snap = snapshotOf(st);
  if (snap) st.session.saveSession(st.week, JSON.stringify(snap));
}

/** A saved snapshot, or why it cannot be used. Never throws: bad saved state must not crash-loop. */
export function parseSession(raw: string): { snapshot: SessionSnapshot } | { error: string } {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch (e) {
    return { error: `the saved session is not valid JSON (${(e as Error).message})` };
  }
  const s = v as Partial<SessionSnapshot> | null;
  if (!s || typeof s !== "object") return { error: "the saved session is not an object" };
  if (s.v !== SESSION_VERSION) return { error: `the saved session is version ${String(s.v)}, this code reads version ${SESSION_VERSION}` };
  const r = s.reminder;
  if (!r || typeof r.channel !== "string" || typeof r.sentAt !== "string" || !Array.isArray(r.input?.candidates)) {
    return { error: "the saved session has no usable reminder" };
  }
  if (!s.selections || typeof s.selections !== "object" || !Array.isArray(s.drafts)) return { error: "the saved session is missing its selections or drafts" };
  for (const d of s.drafts) {
    if (!d || typeof d.key !== "string" || !d.draft || !Array.isArray(d.items)) return { error: "the saved session has a malformed draft" };
  }
  return { snapshot: s as SessionSnapshot };
}

/**
 * The review saved for a week, if one is under way. `error` means something was saved but cannot
 * be used; the caller alerts and starts fresh rather than stopping.
 */
export function loadReview(storage: Pick<Storage, "loadSession">, week: string): { snapshot: SessionSnapshot } | { error: string } | undefined {
  const raw = storage.loadSession(week);
  return raw === undefined ? undefined : parseSession(raw);
}

/**
 * Every campaign Approve has created, whichever week it was in: unsent ones become sendable
 * again, sent ones are remembered so Send refuses them by name.
 */
export function loadCampaigns(st: SurfaceState, storage: Pick<Storage, "listCampaigns">): void {
  for (const c of storage.listCampaigns()) {
    if (c.sent_at) (st.sent ??= new Set()).add(c.id);
    else st.campaigns.add(c.id);
  }
}

/**
 * Put a saved review back. The candidate list is the one Bader was shown, not a fresh fetch, so
 * what he ticked still refers to the items on screen, hand-added events included.
 */
export function restoreSession(st: SurfaceState, snap: SessionSnapshot): void {
  st.candidates = snap.reminder.input.candidates;
  st.reminder = { input: snap.reminder.input, channel: snap.reminder.channel, ...(snap.reminder.ts ? { ts: snap.reminder.ts } : {}), sentAt: snap.reminder.sentAt };
  st.selections = new Map(Object.entries(snap.selections));
  st.drafts = new Map(snap.drafts.map((d) => [d.key, d]));
  if (snap.postedDraft) st.postedDraft = snap.postedDraft;
  // The link in the draft message keeps working: the page is served again at its saved address.
  for (const d of snap.drafts) if (d.previewId) st.preview?.put(d.draft.html, d.previewId);
}
