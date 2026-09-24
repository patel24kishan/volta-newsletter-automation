/**
 * What happens when Bader acts. Framework-free: handlers take a minimal client so tests can
 * pass a recorder. The Bolt wrapper (slack.ts) adapts real payloads to these.
 * Every post goes through assertLive: dry-run never reaches a human (CLAUDE.md section 4).
 */
import type { Alerter } from "../alerts.js";
import type { Cadence, SourceConfig } from "../config.js";
import type { Draft } from "../draft/templates.js";
import type { ManualEventErrors, ManualEventFields } from "../manual-events.js";
import type { RankedItem } from "../pipeline/rank.js";
import { addEvent, approve, buildDraft, send } from "../review/review.js";
import { assertLive } from "../runtime.js";
import type { Item } from "../schema.js";
import type { Storage } from "../storage.js";
import type { Publisher } from "../publish/types.js";
import { approvedBlocks, draftBlocks, draftNotesBlocks, reminderBlocks, sentBlocks, supersededDraftBlocks, type ReminderInput } from "./blocks.js";
import { persistSession, type DraftRecord } from "./session.js";

export interface SlackClient {
  postMessage(args: { channel: string; text: string; blocks?: unknown[]; thread_ts?: string }): Promise<{ ts?: string; channel?: string }>;
  openDm(userId: string): Promise<string>;
  /** Re-render a message already posted, so the candidate list stays one message. */
  updateMessage?(args: { channel: string; ts: string; text: string; blocks?: unknown[] }): Promise<void>;
}

export interface SurfaceState {
  candidates: RankedItem[];
  timeZone: string;
  outDir: string;
  /** The current draft, by the key its Approve button carries, so Approve can find it. */
  drafts: Map<string, DraftRecord>;
  /** Last selection per channel, updated on every checkbox change as a fallback to state.values. */
  selections: Map<string, string[]>;
  env: NodeJS.ProcessEnv;
  /** Email platform handoff. Undefined means the demo stops at the approved file. */
  publisher?: Publisher;
  /** Audience details from publisher.verify(), for the confirmation message. */
  audience?: { audienceName: string; memberCount: number };
  /** Campaigns Approve created and nobody has sent yet; Send acts only on these. */
  campaigns: Set<string>;
  /** Campaigns already sent, so a second press of Send is refused by name rather than by accident. */
  sent?: Set<string>;
  /** The reminder as posted, so an added event can be merged into that same message. */
  reminder?: { input: ReminderInput; channel: string; ts?: string; sentAt?: string };
  /** Where the review is saved so a restart does not lose it. Absent means nothing is saved. */
  session?: Pick<Storage, "saveSession" | "recordCampaign" | "markCampaignSent"> & Partial<Pick<Storage, "listCampaigns" | "forgetCampaign">>;
  /**
   * The period this review belongs to, which it is saved under: the Monday of the week (weekly) or
   * the month, such as 2026-10 (monthly). Named `week` from when every newsletter was weekly.
   */
  week?: string;
  /** The curator's own wording for items, kept per period (src/review/edits.ts). Absent means no edits. */
  edits?: Pick<Storage, "setCuratorEdit" | "listCuratorEdits" | "clearCuratorEdits">;
  /** Whether the newsletter is weekly or monthly, for its wording. Weekly when absent. */
  cadence?: Cadence;
  /** Where events the curator adds are kept. Absent means the Add an event form is not offered. */
  storage?: Pick<Storage, "addManualEvent" | "deleteManualEvent">;
  /** The manual source's config, so an added event links and types like a calendar event. */
  manualSource?: SourceConfig & { fallback_link: string };
  /** The run's clock, so re-ranking after an addition matches the ranking already shown. */
  now?: () => Date;
  /** Which layout the newsletter is built in, from config. */
  layout?: Draft["id"];
  /** The draft message as posted, so a rebuild can retire it. */
  postedDraft?: { key: string; channel: string; ts?: string };
  /** Serves the rendered email. Undefined means no "Preview in browser" button is offered. */
  preview?: { put(html: string, id?: string): string };
}

export async function sendReminder(client: SlackClient, userId: string, input: ReminderInput, st: SurfaceState): Promise<{ channel: string; ts?: string }> {
  assertLive("send the Slack reminder DM", st.env);
  const channel = await client.openDm(userId);
  const res = await client.postMessage({ channel, text: reminderText(input.candidates.length), blocks: reminderBlocks(input) });
  st.reminder = { input, channel, ...(res.ts ? { ts: res.ts } : {}), sentAt: (st.now?.() ?? new Date()).toISOString() };
  // What arrived pre-ticked is the selection until Bader changes it, so a restart before his
  // first tick keeps the same ticks rather than re-ranking a fresh list against a later clock.
  st.selections.set(channel, input.preselectedIds);
  st.week ??= input.firstWorkday.weekMonday;
  persistSession(st);
  return { channel, ...(res.ts ? { ts: res.ts } : {}) };
}

function reminderText(n: number): string {
  return `This week's newsletter is ready: ${n} candidate item(s). Open Slack to select and generate drafts.`;
}

/**
 * Add an event the curator knows about that no source lists (the review core stores it and ticks
 * it), then show it in the list already posted. The list labels the item as the curator's.
 */
export async function addManualEvent(client: SlackClient, fields: ManualEventFields, st: SurfaceState): Promise<{ item?: Item; errors?: ManualEventErrors }> {
  assertLive("add an event to the candidate list", st.env);
  const r0 = st.reminder;
  const res0 = addEvent(st, fields);
  if ("errors" in res0) return { errors: res0.errors };
  const { item } = res0;
  const r = st.reminder;
  if (!r0 || !r) return { item };

  const blocks = reminderBlocks(r.input);
  const text = reminderText(r.input.candidates.length);
  // Editing the original message keeps one list. If it can no longer be edited, post it afresh.
  if (client.updateMessage && r.ts) {
    let edited = false;
    try {
      await client.updateMessage({ channel: r.channel, ts: r.ts, text, blocks });
      edited = true;
      await client.postMessage({ channel: r.channel, text: `Added "${item.title}". It is in the list above, ticked.`, thread_ts: r.ts });
    } catch { /* handled below: only a failed edit warrants a second list */ }
    // Once the list is edited, a failed confirmation is not a reason to post it again.
    if (edited) return { item };
  }
  const res = await client.postMessage({ channel: r.channel, text, blocks });
  st.reminder = { ...st.reminder!, channel: r.channel, ...(res.ts ? { ts: res.ts } : {}) };
  persistSession(st);
  return { item };
}

export function rememberSelection(st: SurfaceState, channel: string, ids: string[]): void {
  st.selections.set(channel, ids);
  persistSession(st);
}

export async function generateDrafts(client: SlackClient, channel: string, selectedIds: string[], st: SurfaceState, alerter: Alerter, threadTs?: string): Promise<Draft[]> {
  assertLive("post generated drafts to Slack", st.env);
  const thread = threadTs ? { thread_ts: threadTs } : {};
  // Captured before it is replaced, so the retired message names its own newsletter.
  const previousPost = st.postedDraft;
  const previousRecord = previousPost ? st.drafts.get(previousPost.key) : undefined;

  const built = buildDraft(st, alerter, selectedIds);
  if (!built.ok && built.reason === "nothing-selected") {
    await client.postMessage({ channel, text: "Nothing is selected. Tick at least one item, then press Generate drafts again.", ...thread });
    return [];
  }
  // The newsletter carries no review labels or notes to the editor, so they are said here instead.
  const notes = draftNotesBlocks(built.ok ? built.items : built.reason === "not-verified" ? built.items : []);
  if (notes.length) {
    await client.postMessage({ channel, text: "Before you read the draft, two things about the items you picked.", blocks: notes, ...thread });
  }
  // A failed rebuild leaves the previous draft exactly as it was, still readable and approvable.
  if (!built.ok) {
    await client.postMessage({ channel, text: "No draft passed verification. A maintainer has been alerted.", ...thread });
    return [];
  }

  // A draft built from an older selection must stop being approvable the moment a newer one exists.
  await supersedePreviousDraft(client, previousPost, previousRecord?.draft);

  const { key, draft: d } = built;
  const res = await client.postMessage({
    channel, text: `This week's newsletter: ${d.name} — ${d.subject}`,
    blocks: draftBlocks(d, { key, itemCount: built.items.length, ...(built.previewUrl ? { previewUrl: built.previewUrl } : {}) }),
    ...thread,
  });
  st.postedDraft = { key, channel, ...(res.ts ? { ts: res.ts } : {}) };
  persistSession(st);
  return [d];
}

async function supersedePreviousDraft(client: SlackClient, posted: SurfaceState["postedDraft"], previous: Draft | undefined): Promise<void> {
  if (!posted?.ts || !client.updateMessage) return;
  try {
    await client.updateMessage({
      channel: posted.channel, ts: posted.ts,
      text: "An earlier draft, replaced by a newer one.",
      blocks: previous ? supersededDraftBlocks(previous) : [{ type: "context", elements: [{ type: "mrkdwn", text: "A newer draft was generated below. This one can no longer be approved." }] }],
    });
  } catch { /* the message may be gone; its Approve no longer matches any draft, so it is harmless */ }
}

/**
 * Bring the candidate list back to the bottom of the conversation so the selection can be fixed
 * without scrolling for it, with everything currently ticked still ticked. Adding a forgotten
 * event is the same list's Add an event button, so nothing else is needed here.
 */
export async function changeItems(client: SlackClient, st: SurfaceState): Promise<void> {
  assertLive("re-post the candidate list", st.env);
  const r = st.reminder;
  if (!r) throw new Error("the candidate list is not available in this session");
  const ticked = st.selections.get(r.channel) ?? r.input.preselectedIds;
  const input: ReminderInput = { ...r.input, candidates: st.candidates, preselectedIds: ticked };
  const res = await client.postMessage({ channel: r.channel, text: reminderText(input.candidates.length), blocks: reminderBlocks(input) });
  // The freshest list becomes the one an added event updates. Spread, so the time the reminder
  // was sent survives: without it the review would no longer be saved at all.
  st.reminder = { ...r, input, ...(res.ts ? { ts: res.ts } : {}) };
  persistSession(st);
}

export async function approveDraft(client: SlackClient, channel: string, draftKey: string, st: SurfaceState, threadTs?: string): Promise<{ html: string; md: string } | undefined> {
  assertLive("confirm the approved draft in Slack", st.env);
  const thread = threadTs ? { thread_ts: threadTs } : {};
  const r = await approve(st, draftKey);
  switch (r.status) {
    case "missing":
      await client.postMessage({ channel, text: "That draft is no longer available. Press Generate drafts again.", ...thread });
      return undefined;
    case "saved":
      await client.postMessage({ channel, text: `Approved: ${r.draft.name}. Saved to ${r.files.html}`, blocks: approvedBlocks(r.draft, r.files, undefined, r.held), ...thread });
      return r.files;
    case "failed":
      await client.postMessage({ channel, text: `Approved and saved to ${r.files.html}, but creating the ${r.platform} campaign failed: ${r.error.message}`, ...thread });
      throw r.error;
    case "already":
      await client.postMessage({ channel, text: `Already approved: ${r.draft.name}. Its campaign is in ${r.campaign.platform}: ${r.campaign.editUrl}`, blocks: approvedBlocks(r.draft, r.files, { ...r.campaign, ...r.audience }, r.held), ...thread });
      return r.files;
    case "period-sent":
      await client.postMessage({ channel, text: `This newsletter was already sent (campaign ${r.campaignId}). The new version was saved to ${r.files.html} but not applied.`, ...thread });
      return r.files;
    case "updated":
      await client.postMessage({ channel, text: `Approved: ${r.draft.name}. The existing campaign in ${r.campaign.platform} was updated; edits made there directly were replaced.`, blocks: approvedBlocks(r.draft, r.files, { ...r.campaign, ...r.audience }, r.held), ...thread });
      return r.files;
    case "created":
      await client.postMessage({ channel, text: `Approved: ${r.draft.name}. Campaign created in ${r.campaign.platform}: ${r.campaign.editUrl}`, blocks: approvedBlocks(r.draft, r.files, { ...r.campaign, ...r.audience }, r.held), ...thread });
      return r.files;
  }
}

export async function sendCampaign(client: SlackClient, channel: string, campaignId: string, st: SurfaceState, threadTs?: string): Promise<boolean> {
  const thread = threadTs ? { thread_ts: threadTs } : {};
  const r = await send(st, campaignId);
  const refusal = {
    "no-platform": "No email platform is configured.",
    "already-sent": "That campaign has already been sent. It will not be sent a second time.",
    unknown: "That campaign was not created in this session, so it will not be sent from here. Open it in the email platform instead.",
  } as const;
  if (r.status !== "sent") {
    await client.postMessage({ channel, text: refusal[r.status], ...thread });
    return false;
  }
  await client.postMessage({ channel, text: `Sent via ${r.platform}.`, blocks: sentBlocks(r.platform, campaignId), ...thread });
  return true;
}
