/**
 * What happens when Bader acts. Framework-free: handlers take a minimal client so tests can
 * pass a recorder. The Bolt wrapper (slack.ts) adapts real payloads to these.
 * Every post goes through assertLive: dry-run never reaches a human (CLAUDE.md section 4).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Alerter } from "../alerts.js";
import type { SourceConfig } from "../config.js";
import { buildDrafts, type Draft } from "../draft/templates.js";
import { itemFromManualEvent, manualEventFromFields, validateManualEvent, type ManualEventErrors, type ManualEventFields } from "../manual-events.js";
import { rankItems, type RankedItem } from "../pipeline/rank.js";
import { assertLive } from "../runtime.js";
import type { Item } from "../schema.js";
import type { Storage } from "../storage.js";
import type { Publisher } from "../publish/types.js";
import { approvedBlocks, draftBlocks, draftNotesBlocks, reminderBlocks, sentBlocks, supersededDraftBlocks, type ReminderInput } from "./blocks.js";

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
  /** Drafts generated in this session, by draft id, so Approve can find them. */
  drafts: Map<string, Draft>;
  /** Last selection per channel, updated on every checkbox change as a fallback to state.values. */
  selections: Map<string, string[]>;
  env: NodeJS.ProcessEnv;
  /** Email platform handoff. Undefined means the demo stops at the approved file. */
  publisher?: Publisher;
  /** Audience details from publisher.verify(), for the confirmation message. */
  audience?: { audienceName: string; memberCount: number };
  /** Campaign ids created this session, so Send only acts on what Approve created. */
  campaigns: Set<string>;
  /** The reminder as posted, so an added event can be merged into that same message. */
  reminder?: { input: ReminderInput; channel: string; ts?: string };
  /** Where events the curator adds are kept. Absent means the Add an event form is not offered. */
  storage?: Pick<Storage, "addManualEvent">;
  /** The manual source's config, so an added event links and types like a calendar event. */
  manualSource?: SourceConfig & { fallback_link: string };
  /** The run's clock, so re-ranking after an addition matches the ranking already shown. */
  now?: () => Date;
  /** Which layout the newsletter is built in, from config. */
  layout?: Draft["id"];
  /** The draft message as posted, so a rebuild can retire it. */
  postedDraft?: { draftId: string; channel: string; ts?: string };
  /** Serves the rendered email. Undefined means no "Preview in browser" button is offered. */
  preview?: { put(html: string): string };
}

export async function sendReminder(client: SlackClient, userId: string, input: ReminderInput, st: SurfaceState): Promise<{ channel: string; ts?: string }> {
  assertLive("send the Slack reminder DM", st.env);
  const channel = await client.openDm(userId);
  const res = await client.postMessage({ channel, text: reminderText(input.candidates.length), blocks: reminderBlocks(input) });
  st.reminder = { input, channel, ...(res.ts ? { ts: res.ts } : {}) };
  return { channel, ...(res.ts ? { ts: res.ts } : {}) };
}

function reminderText(n: number): string {
  return `This week's newsletter is ready: ${n} candidate item(s). Open Slack to select and generate drafts.`;
}

/**
 * Add an event the curator knows about that no source lists. It is stored, so it survives a
 * restart and reappears on the next run, then shown in the candidate list already ticked: adding
 * it is the decision, so it should not have to be made twice. Nothing is invented on their behalf,
 * and the list labels the item as theirs.
 */
export async function addManualEvent(client: SlackClient, fields: ManualEventFields, st: SurfaceState): Promise<{ item?: Item; errors?: ManualEventErrors }> {
  assertLive("add an event to the candidate list", st.env);
  if (!st.storage || !st.manualSource) throw new Error("no manual events source is configured, so an event cannot be added");
  const input = manualEventFromFields(fields, st.timeZone);
  const errors = validateManualEvent(input, st.now?.() ?? new Date());
  if (Object.keys(errors).length) return { errors };

  const saved = st.storage.addManualEvent(input);
  const item = itemFromManualEvent(saved, st.manualSource, st.manualSource.fallback_link);
  st.candidates = rankItems([...st.candidates.map((c) => c.item), item], st.now?.() ?? new Date());

  const r = st.reminder;
  if (!r) return { item };
  // Whatever was already ticked stays ticked, and the new event joins them.
  const ticked = st.selections.get(r.channel) ?? r.input.preselectedIds;
  const nextInput: ReminderInput = { ...r.input, candidates: st.candidates, preselectedIds: [...new Set([...ticked, item.id])] };
  st.reminder = { ...r, input: nextInput };
  st.selections.set(r.channel, nextInput.preselectedIds);

  const blocks = reminderBlocks(nextInput);
  const text = reminderText(nextInput.candidates.length);
  // Editing the original message keeps one list. A restart loses its timestamp, so post afresh.
  if (client.updateMessage && r.ts) {
    try {
      await client.updateMessage({ channel: r.channel, ts: r.ts, text, blocks });
      await client.postMessage({ channel: r.channel, text: `Added "${item.title}". It is in the list above, ticked.`, thread_ts: r.ts });
      return { item };
    } catch { /* fall through to a fresh message */ }
  }
  const res = await client.postMessage({ channel: r.channel, text, blocks });
  st.reminder = { input: nextInput, channel: r.channel, ...(res.ts ? { ts: res.ts } : {}) };
  return { item };
}

export function rememberSelection(st: SurfaceState, channel: string, ids: string[]): void {
  st.selections.set(channel, ids);
}

export async function generateDrafts(client: SlackClient, channel: string, selectedIds: string[], st: SurfaceState, alerter: Alerter, threadTs?: string): Promise<Draft[]> {
  assertLive("post generated drafts to Slack", st.env);
  const byId = new Map(st.candidates.map((c) => [c.item.id, c.item] as const));
  const selected: Item[] = selectedIds.map((id) => byId.get(id)).filter((x): x is Item => Boolean(x));
  if (selected.length === 0) {
    await client.postMessage({ channel, text: "Nothing is selected. Tick at least one item, then press Generate drafts again.", ...(threadTs ? { thread_ts: threadTs } : {}) });
    return [];
  }
  const drafts = buildDrafts(selected, { timeZone: st.timeZone, layouts: [st.layout ?? "events-first"] });
  const good = drafts.filter((d) => d.verification.ok);
  for (const d of drafts.filter((d) => !d.verification.ok)) {
    alerter.alert("error", `draft:${d.id}`, `withheld: ${d.verification.violations.map((v) => `${v.kind} "${v.value}"`).join(", ")}`, "inspect the items; the draft was not shown");
  }
  st.drafts.clear();
  for (const d of good) st.drafts.set(d.id, d);

  // The newsletter carries no review labels or notes to the editor, so they are said here instead.
  const notes = draftNotesBlocks(selected);
  if (notes.length) {
    await client.postMessage({
      channel, text: "Before you read the draft, two things about the items you picked.",
      blocks: notes, ...(threadTs ? { thread_ts: threadTs } : {}),
    });
  }

  if (good.length === 0) {
    await client.postMessage({ channel, text: "No draft passed verification. A maintainer has been alerted.", ...(threadTs ? { thread_ts: threadTs } : {}) });
    return [];
  }

  // A draft built from an older selection must stop being approvable the moment a newer one exists.
  await supersedePreviousDraft(client, st);

  const d = good[0]!;
  const previewUrl = st.preview?.put(d.html);
  const res = await client.postMessage({
    channel, text: `This week's newsletter: ${d.name} — ${d.subject}`,
    blocks: draftBlocks(d, { itemCount: selected.length, ...(previewUrl ? { previewUrl } : {}) }),
    ...(threadTs ? { thread_ts: threadTs } : {}),
  });
  st.postedDraft = { draftId: d.id, channel, ...(res.ts ? { ts: res.ts } : {}) };
  return good;
}

async function supersedePreviousDraft(client: SlackClient, st: SurfaceState): Promise<void> {
  const posted = st.postedDraft;
  const previous = posted && st.drafts.get(posted.draftId);
  if (!posted?.ts || !client.updateMessage) return;
  try {
    await client.updateMessage({
      channel: posted.channel, ts: posted.ts,
      text: "An earlier draft, replaced by a newer one.",
      blocks: previous ? supersededDraftBlocks(previous) : [{ type: "context", elements: [{ type: "mrkdwn", text: "A newer draft was generated below. This one can no longer be approved." }] }],
    });
  } catch { /* an older process posted it; leaving it alone is better than failing the rebuild */ }
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
  // The freshest list becomes the one an added event updates.
  st.reminder = { input, channel: r.channel, ...(res.ts ? { ts: res.ts } : {}) };
}

export async function approveDraft(client: SlackClient, channel: string, draftId: string, st: SurfaceState, threadTs?: string): Promise<{ html: string; md: string } | undefined> {
  assertLive("confirm the approved draft in Slack", st.env);
  const d = st.drafts.get(draftId);
  if (!d) {
    await client.postMessage({ channel, text: "That draft is no longer available. Press Generate drafts again.", ...(threadTs ? { thread_ts: threadTs } : {}) });
    return undefined;
  }
  mkdirSync(st.outDir, { recursive: true });
  const paths = { html: join(st.outDir, "final.html"), md: join(st.outDir, "final.md") };
  writeFileSync(paths.html, d.html, "utf8");
  writeFileSync(paths.md, d.markdown, "utf8");

  // Held items that made it into this draft, so the last message before Send names them.
  const inDraft = new Set(d.item_ids);
  const held = st.candidates.map((c) => c.item).filter((i) => i.requires_review && inDraft.has(i.id));

  if (!st.publisher) {
    await client.postMessage({ channel, text: `Approved: ${d.name}. Saved to ${paths.html}`, blocks: approvedBlocks(d, paths, undefined, held), ...(threadTs ? { thread_ts: threadTs } : {}) });
    return paths;
  }
  try {
    const c = await st.publisher.publishDraft(d);
    st.campaigns.add(c.id);
    const audience = st.audience ?? { audienceName: "audience", memberCount: 0 };
    await client.postMessage({ channel, text: `Approved: ${d.name}. Campaign created in ${c.platform}: ${c.editUrl}`, blocks: approvedBlocks(d, paths, { ...c, ...audience }, held), ...(threadTs ? { thread_ts: threadTs } : {}) });
  } catch (e) {
    await client.postMessage({ channel, text: `Approved and saved to ${paths.html}, but creating the ${st.publisher.platform} campaign failed: ${(e as Error).message}`, ...(threadTs ? { thread_ts: threadTs } : {}) });
    throw e;
  }
  return paths;
}

export async function sendCampaign(client: SlackClient, channel: string, campaignId: string, st: SurfaceState, threadTs?: string): Promise<boolean> {
  assertLive("send the email campaign", st.env);
  if (!st.publisher) {
    await client.postMessage({ channel, text: "No email platform is configured.", ...(threadTs ? { thread_ts: threadTs } : {}) });
    return false;
  }
  if (!st.campaigns.has(campaignId)) {
    await client.postMessage({ channel, text: "That campaign was not created in this session, so it will not be sent from here. Open it in the email platform instead.", ...(threadTs ? { thread_ts: threadTs } : {}) });
    return false;
  }
  await st.publisher.send(campaignId);
  await client.postMessage({ channel, text: `Sent via ${st.publisher.platform}.`, blocks: sentBlocks(st.publisher.platform, campaignId), ...(threadTs ? { thread_ts: threadTs } : {}) });
  return true;
}
