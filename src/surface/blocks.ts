/**
 * Block Kit builders. Pure functions returning JSON so tests can assert the exact shape.
 * Accessibility: every control has a text label, nothing depends on colour, links carry titles.
 */
import type { Draft } from "../draft/templates.js";
import type { RankedItem } from "../pipeline/rank.js";
import type { FirstWorkday } from "../schedule/first-workday.js";
import { partsInZone } from "../clock.js";
import { chunkMrkdwn, escapeMrkdwn, markdownToMrkdwn } from "./mrkdwn.js";

export const ACTION = {
  select: "newsletter_select",
  generate: "newsletter_generate",
  approve: "newsletter_approve",
} as const;

export const BLOCK_PREFIX = { select: "select_" } as const;
const CHECKBOX_LIMIT = 10; // Slack allows at most 10 options per checkboxes element

export interface ReminderInput {
  candidates: RankedItem[];
  preselectedIds: string[];
  firstWorkday: FirstWorkday;
  timeZone: string;
  clockLabel: string;
  sourceNotes: string[];
}

type Block = Record<string, unknown>;

export function reminderBlocks(input: ReminderInput): Block[] {
  const { candidates, preselectedIds, firstWorkday, timeZone } = input;
  const pre = new Set(preselectedIds);
  const blocks: Block[] = [
    { type: "header", text: { type: "plain_text", text: "This week's newsletter is ready for you", emoji: false } },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `First workday: *${cap(firstWorkday.weekday)} ${firstWorkday.date}*` +
          (firstWorkday.skipped.length ? ` (skipped ${firstWorkday.skipped.map((s) => s.split(":")[0]).join(", ")})` : "") +
          `\n${candidates.length} candidate item(s) below, the ${pre.size} highest-ranked pre-ticked. Untick anything you do not want, then press *Generate drafts*.` +
          (input.clockLabel.startsWith("overridden") ? `\n_Demo clock: ${escapeMrkdwn(input.clockLabel)}_` : ""),
      },
    },
  ];
  for (const note of input.sourceNotes) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: escapeMrkdwn(note) }] });

  if (candidates.length === 0) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: "No items were found from any source this week. Nothing to select." } });
    return blocks;
  }

  blocks.push({ type: "divider" });
  for (let i = 0; i < candidates.length; i += CHECKBOX_LIMIT) {
    const slice = candidates.slice(i, i + CHECKBOX_LIMIT);
    const options = slice.map((c) => option(c, timeZone));
    const initial = options.filter((o) => pre.has(o.value));
    const element: Block = { type: "checkboxes", action_id: ACTION.select, options };
    if (initial.length) element.initial_options = initial;
    blocks.push({
      type: "section",
      block_id: `${BLOCK_PREFIX.select}${i / CHECKBOX_LIMIT}`,
      text: { type: "mrkdwn", text: i === 0 ? "*Candidates*" : `*Candidates (continued)*` },
      accessory: element,
    });
  }
  blocks.push({
    type: "actions",
    block_id: "generate_actions",
    elements: [{ type: "button", style: "primary", action_id: ACTION.generate, text: { type: "plain_text", text: "Generate drafts", emoji: false }, value: "generate" }],
  });
  return blocks;
}

function option(c: RankedItem, timeZone: string): { text: { type: "mrkdwn"; text: string }; description?: { type: "plain_text"; text: string }; value: string } {
  const it = c.item;
  const p = partsInZone(new Date(it.date), timeZone);
  const when = it.type === "event" ? `${cap(p.weekday)} ${p.month}/${p.day}` : `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
  const label = `<${it.link}|${escapeMrkdwn(trim(it.title, 60))}>`;
  const bits = [`${it.type} · ${when}`];
  if (it.related?.length) bits.push(`+${it.related.length} related`);
  if (it.needs_summary) bits.push("needs summary");
  const description = trim(`${bits.join(" · ")}${it.summary ? ` · ${it.summary}` : ""}`, 75);
  return { text: { type: "mrkdwn", text: label }, description: { type: "plain_text", text: description }, value: it.id };
}

export function draftBlocks(d: Draft, index: number, total: number): Block[] {
  const blocks: Block[] = [
    { type: "header", text: { type: "plain_text", text: `Draft ${index + 1} of ${total}: ${d.name}`, emoji: false } },
    { type: "context", elements: [{ type: "mrkdwn", text: `Subject: ${escapeMrkdwn(d.subject)} · ${d.item_ids.length} item(s) · verified: ${d.verification.ok ? "yes" : "NO"}` }] },
  ];
  for (const chunk of chunkMrkdwn(markdownToMrkdwn(d.markdown))) blocks.push({ type: "section", text: { type: "mrkdwn", text: chunk } });
  blocks.push({
    type: "actions",
    block_id: `approve_${d.id}`,
    elements: [{ type: "button", style: "primary", action_id: ACTION.approve, text: { type: "plain_text", text: `Approve draft ${index + 1}`, emoji: false }, value: d.id }],
  });
  return blocks;
}

export function approvedBlocks(d: Draft, paths: { html: string; md: string }): Block[] {
  return [
    { type: "section", text: { type: "mrkdwn", text: `*Approved: ${escapeMrkdwn(d.name)}*\nSubject: ${escapeMrkdwn(d.subject)}\nSaved to \`${paths.html}\` and \`${paths.md}\`.\nNext step in production: this draft becomes the email campaign for you to edit and send.` } },
  ];
}

/** Item ids ticked across every select_* block in a block_actions payload's state. */
export function selectedIdsFromState(state: unknown): string[] {
  const values = (state as { values?: Record<string, Record<string, { selected_options?: Array<{ value: string }> }>> } | undefined)?.values ?? {};
  const ids: string[] = [];
  for (const [blockId, actions] of Object.entries(values)) {
    if (!blockId.startsWith(BLOCK_PREFIX.select)) continue;
    for (const a of Object.values(actions)) for (const o of a.selected_options ?? []) ids.push(o.value);
  }
  return ids;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function trim(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
