/**
 * What happens when Bader acts. Framework-free: handlers take a minimal client so tests can
 * pass a recorder. The Bolt wrapper (slack.ts) adapts real payloads to these.
 * Every post goes through assertLive: dry-run never reaches a human (CLAUDE.md section 4).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Alerter } from "../alerts.js";
import { buildDrafts, type Draft } from "../draft/templates.js";
import type { RankedItem } from "../pipeline/rank.js";
import { assertLive } from "../runtime.js";
import type { Item } from "../schema.js";
import { approvedBlocks, draftBlocks, reminderBlocks, type ReminderInput } from "./blocks.js";

export interface SlackClient {
  postMessage(args: { channel: string; text: string; blocks?: unknown[]; thread_ts?: string }): Promise<{ ts?: string; channel?: string }>;
  openDm(userId: string): Promise<string>;
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
}

export async function sendReminder(client: SlackClient, userId: string, input: ReminderInput, st: SurfaceState): Promise<{ channel: string; ts?: string }> {
  assertLive("send the Slack reminder DM", st.env);
  const channel = await client.openDm(userId);
  const res = await client.postMessage({ channel, text: `This week's newsletter is ready: ${input.candidates.length} candidate item(s). Open Slack to select and generate drafts.`, blocks: reminderBlocks(input) });
  return { channel, ...(res.ts ? { ts: res.ts } : {}) };
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
  const drafts = buildDrafts(selected, { timeZone: st.timeZone });
  const good = drafts.filter((d) => d.verification.ok);
  for (const d of drafts.filter((d) => !d.verification.ok)) {
    alerter.alert("error", `draft:${d.id}`, `withheld: ${d.verification.violations.map((v) => `${v.kind} "${v.value}"`).join(", ")}`, "inspect the items; the draft was not shown");
  }
  st.drafts.clear();
  for (const d of good) st.drafts.set(d.id, d);
  await client.postMessage({ channel, text: `${good.length} draft(s) from ${selected.length} selected item(s).`, ...(threadTs ? { thread_ts: threadTs } : {}) });
  for (let i = 0; i < good.length; i++) {
    const d = good[i]!;
    await client.postMessage({ channel, text: `Draft ${i + 1} of ${good.length}: ${d.name} — ${d.subject}`, blocks: draftBlocks(d, i, good.length), ...(threadTs ? { thread_ts: threadTs } : {}) });
  }
  if (good.length === 0) await client.postMessage({ channel, text: "No draft passed verification. A maintainer has been alerted.", ...(threadTs ? { thread_ts: threadTs } : {}) });
  return good;
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
  await client.postMessage({ channel, text: `Approved: ${d.name}. Saved to ${paths.html}`, blocks: approvedBlocks(d, paths), ...(threadTs ? { thread_ts: threadTs } : {}) });
  return paths;
}
