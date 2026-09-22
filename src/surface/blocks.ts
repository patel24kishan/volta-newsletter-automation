/**
 * Block Kit builders. Pure functions returning JSON so tests can assert the exact shape.
 * Accessibility: every control has a text label, nothing depends on colour, links carry titles.
 */
import type { Draft } from "../draft/templates.js";
import type { RankedItem } from "../pipeline/rank.js";
import type { FirstWorkday } from "../schedule/first-workday.js";
import type { Item } from "../schema.js";
import { localDateString, partsInZone } from "../clock.js";
import { isManualItem, MANUAL_LIMITS, type ManualEventErrors, type ManualEventFields } from "../manual-events.js";
import { chunkEntries, chunkMrkdwn, escapeMrkdwn, markdownToMrkdwn } from "./mrkdwn.js";

export const ACTION = {
  select: "newsletter_select",
  generate: "newsletter_generate",
  approve: "newsletter_approve",
  send: "newsletter_send",
  addEvent: "newsletter_add_event",
  changeItems: "newsletter_change_items",
  /** Link buttons: Slack still posts an interaction for these, so they need ids to acknowledge. */
  edit: "newsletter_edit",
  preview: "newsletter_preview",
} as const;

/** The form for an event no source lists yet. Its blocks are keyed so errors land on the field. */
export const ADD_EVENT = {
  callbackId: "newsletter_add_event_form",
  value: "value",
  field: { title: "ev_title", date: "ev_date", time: "ev_time", location: "ev_location", description: "ev_description", link: "ev_link" },
} as const;

export const BLOCK_PREFIX = { select: "select_" } as const;

/** Said in the candidate list and nowhere else, so the newsletter never claims a source it lacks. */
export const MANUAL_LABEL = "added by you";

/** The curator's label for an item the source put on hold. It belongs to Slack, never to a draft. */
export const REVIEW_LABEL = "MARKED FOR REVIEW";
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
  const week = firstWorkday.weekMonday;
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

  // Offered even in a week with no candidates: knowing about an unlisted event is the likeliest
  // reason to open this message when every source was quiet.
  blocks.push({
    type: "actions",
    block_id: "add_event_actions",
    elements: [{ type: "button", action_id: ACTION.addEvent, text: { type: "plain_text", text: "Add an event", emoji: false }, value: week }],
  });

  if (candidates.length === 0) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: "No items were found from any source this week. Nothing to select." } });
    return blocks;
  }

  blocks.push({ type: "divider" });
  // Numbered list with links (sections allow 3000 chars); checkbox labels must stay under 151 chars,
  // so they carry only the number and a short title. Every item keeps its link here (constraint 5).
  // Whole entries are packed into as many sections as it takes. Every candidate keeps its link,
  // however long the list gets.
  const entries = candidates.map((c, n) => linkLine(c, n + 1, timeZone));
  for (const chunk of chunkEntries(entries)) blocks.push({ type: "section", text: { type: "mrkdwn", text: chunk } });

  for (let i = 0; i < candidates.length; i += CHECKBOX_LIMIT) {
    const slice = candidates.slice(i, i + CHECKBOX_LIMIT);
    const options = slice.map((c, k) => option(c, i + k + 1));
    const initial = options.filter((o) => pre.has(o.value));
    const element: Block = { type: "checkboxes", action_id: ACTION.select, options };
    if (initial.length) element.initial_options = initial;
    blocks.push({
      type: "section",
      block_id: `${BLOCK_PREFIX.select}${week}_${i / CHECKBOX_LIMIT}`,
      text: { type: "mrkdwn", text: i === 0 ? "*Candidates*" : `*Candidates (continued)*` },
      accessory: element,
    });
  }
  blocks.push({
    type: "actions",
    block_id: "generate_actions",
    // The week travels with the button: last week's list stays in the same DM, and pressing its
    // Generate must not build this week's newsletter from last week's ticks.
    elements: [{ type: "button", style: "primary", action_id: ACTION.generate, text: { type: "plain_text", text: "Generate drafts", emoji: false }, value: week }],
  });
  return blocks;
}

/**
 * The week a list's control belongs to: from a Generate value or a checkbox block id. Undefined
 * for a message posted before lists carried their week, which is then treated as current, so a
 * list already in Slack keeps working through the deploy that introduced this.
 */
export function weekOfControl(valueOrBlockId: string | undefined): string | undefined {
  return /(\d{4}-\d{2}-\d{2})/.exec(valueOrBlockId ?? "")?.[1];
}

/** True when a control plainly belongs to a different week from the review now under way. */
export function isFromAnotherWeek(currentWeek: string | undefined, valueOrBlockId: string | undefined): boolean {
  const week = weekOfControl(valueOrBlockId);
  return Boolean(week && currentWeek && week !== currentWeek);
}

/** One line per candidate: "1. <link|Title> · event · Thursday 9/24 · +1 related · <permalink|Slack message>". */
function linkLine(c: RankedItem, n: number, timeZone: string): string {
  const it = c.item;
  const p = partsInZone(new Date(it.date), timeZone);
  const when = it.type === "event" ? `${cap(p.weekday)} ${p.month}/${p.day}` : `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
  const bits = [`${it.type} · ${when}`];
  if (isManualItem(it)) bits.push(MANUAL_LABEL);
  if (it.related?.length) bits.push(`+${it.related.length} related`);
  if (it.needs_summary) bits.push("needs summary");
  // Last on the line: the member's Slack message, when the title links somewhere else.
  if (it.message_link && it.message_link !== it.link) bits.push(`<${it.message_link}|Slack message>`);
  const head = `<${it.link}|${escapeMrkdwn(trim(it.title, 80))}> · ${bits.join(" · ")}`;
  if (!it.requires_review) return `${n}. ${head}`;

  // A held item leads with the label, then its first two points, the reason it is held, and the
  // link to the exact message, so the decision can be made without leaving this list.
  const points = (it.insights?.length ? it.insights : it.summary ? [it.summary] : []).slice(0, 2);
  return [
    `${n}. *${REVIEW_LABEL}* · ${head}`,
    ...points.map((p) => `      • ${escapeMrkdwn(trim(p, 220))}`),
    ...(it.hold_note ? [`      _On hold: ${escapeMrkdwn(it.hold_note)}_`] : []),
  ].join("\n");
}

/** Checkbox option: text under 151 chars, description under 76 (Slack limits). */
function option(c: RankedItem, n: number): { text: { type: "plain_text"; text: string }; description?: { type: "plain_text"; text: string }; value: string } {
  const it = c.item;
  // The label sits on the checkbox too, so it is visible at the moment of ticking.
  const text = trim(`${n}. ${it.requires_review ? `${REVIEW_LABEL}: ` : ""}${it.title}`, 140);
  const description = trim(it.summary || `${it.type} · no summary yet`, 75);
  return { text: { type: "plain_text", text }, description: { type: "plain_text", text: description }, value: it.id };
}

/**
 * What the curator should know about the items they just selected, posted with the drafts and
 * never part of a newsletter: which selected items the source put on hold, and what each write-up
 * said to the editor. The drafts leave these out on purpose, so this is where they surface.
 */
export function draftNotesBlocks(selected: Item[]): Block[] {
  const blocks: Block[] = [];
  const held = selected.filter((i) => i.requires_review);
  if (held.length) {
    const lines = held.map((i) => `• *${escapeMrkdwn(i.title)}*${i.hold_note ? ` · on hold: ${escapeMrkdwn(i.hold_note)}` : ""}`);
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `*${held.length} selected item${held.length === 1 ? " is" : "s are"} ${REVIEW_LABEL}.* ${held.length === 1 ? "It is" : "They are"} in these drafts because you ticked ${held.length === 1 ? "it" : "them"}. Check the hold still applies before you send.\n${lines.join("\n")}` } });
  }
  const withNotes = selected.filter((i) => i.editor_notes?.length);
  if (withNotes.length) {
    const entries = withNotes.map((i) => [`*${escapeMrkdwn(i.title)}*`, ...i.editor_notes!.map((n) => `      • ${escapeMrkdwn(trim(n, 300))}`)].join("\n"));
    const chunks = chunkEntries(entries);
    chunks.forEach((chunk, k) => blocks.push({ type: "section", text: { type: "mrkdwn", text: k === 0 ? `*Notes to the editor from the write-ups* (not in the newsletter)\n${chunk}` : chunk } }));
  }
  return blocks;
}

/**
 * The form for an event no source lists yet. Only the name, date and time are required: a link may
 * not exist yet, and a blank description marks the item "needs summary" rather than inventing one.
 * The time is labelled with the newsletter's timezone, because that is how it is read back.
 */
export function addEventView(opts: { timeZone: string; now: Date; privateMetadata?: string }): Record<string, unknown> {
  const input = (block: string, label: string, element: Block, optional = false, hint?: string): Block => ({
    type: "input", block_id: block, label: { type: "plain_text", text: label, emoji: false }, element,
    ...(optional ? { optional: true } : {}),
    ...(hint ? { hint: { type: "plain_text", text: hint, emoji: false } } : {}),
  });
  const text = (max: number, placeholder: string): Block => ({
    type: "plain_text_input", action_id: ADD_EVENT.value, max_length: max,
    placeholder: { type: "plain_text", text: placeholder, emoji: false },
  });
  return {
    type: "modal",
    callback_id: ADD_EVENT.callbackId,
    title: { type: "plain_text", text: "Add an event", emoji: false },
    submit: { type: "plain_text", text: "Add to the list", emoji: false },
    close: { type: "plain_text", text: "Cancel", emoji: false },
    ...(opts.privateMetadata ? { private_metadata: opts.privateMetadata } : {}),
    blocks: [
      { type: "context", elements: [{ type: "mrkdwn", text: "For something that is happening but is not on the calendar or in the news yet. It joins the list already ticked." }] },
      input(ADD_EVENT.field.title, "Event name", text(MANUAL_LIMITS.title, "Demo Night")),
      input(ADD_EVENT.field.date, "Date", { type: "datepicker", action_id: ADD_EVENT.value, initial_date: localDateString(opts.now, opts.timeZone) }),
      input(ADD_EVENT.field.time, "Start time", { type: "timepicker", action_id: ADD_EVENT.value, initial_time: "18:00" }, false, `In ${opts.timeZone} time.`),
      input(ADD_EVENT.field.location, "Location", text(MANUAL_LIMITS.location, "Volta, 1505 Barrington St"), true),
      input(ADD_EVENT.field.description, "One line about it", text(MANUAL_LIMITS.description, "An evening of founder demos."), true,
        "Appears in the newsletter word for word. Leave it blank and the item is flagged as needing a summary."),
      input(ADD_EVENT.field.link, "Link", { type: "url_text_input", action_id: ADD_EVENT.value }, true,
        "Optional. Blank links to the events page instead."),
    ],
  };
}

/** Read the submitted form. Values only, so validation and its messages stay in one place. */
export function addEventFields(viewState: unknown): ManualEventFields {
  const values = (viewState as { values?: Record<string, Record<string, Record<string, unknown>>> } | undefined)?.values ?? {};
  const read = (block: string, key: string): string => {
    const v = values[block]?.[ADD_EVENT.value]?.[key];
    return typeof v === "string" ? v.trim() : "";
  };
  return {
    title: read(ADD_EVENT.field.title, "value"),
    date: read(ADD_EVENT.field.date, "selected_date"),
    time: read(ADD_EVENT.field.time, "selected_time"),
    location: read(ADD_EVENT.field.location, "value"),
    description: read(ADD_EVENT.field.description, "value"),
    link: read(ADD_EVENT.field.link, "value"),
  };
}

/** Field errors keyed by the block Slack should show them under. */
export function addEventErrorBlocks(errors: ManualEventErrors): Record<string, string> {
  const map: Array<[keyof ManualEventErrors, string]> = [
    ["title", ADD_EVENT.field.title], ["starts_at", ADD_EVENT.field.date],
    ["location", ADD_EVENT.field.location], ["description", ADD_EVENT.field.description], ["link", ADD_EVENT.field.link],
  ];
  const out: Record<string, string> = {};
  for (const [key, block] of map) if (errors[key]) out[block] = errors[key]!;
  return out;
}

/**
 * The newsletter as Slack can show it, with the three things that can be done to it: read the real
 * rendering, change what is in it, or approve it. Read, fix, commit, in that order.
 */
export function draftBlocks(d: Draft, opts: { itemCount: number; previewUrl?: string; key?: string } = { itemCount: 0 }): Block[] {
  const blocks: Block[] = [
    { type: "header", text: { type: "plain_text", text: `This week's newsletter: ${d.name}`, emoji: false } },
    { type: "context", elements: [{ type: "mrkdwn", text: `Subject: ${escapeMrkdwn(d.subject)} · built from ${opts.itemCount || d.item_ids.length} selected item(s) · verified: ${d.verification.ok ? "yes" : "NO"}` }] },
  ];
  for (const chunk of chunkMrkdwn(markdownToMrkdwn(d.markdown))) blocks.push({ type: "section", text: { type: "mrkdwn", text: chunk } });
  const elements: Block[] = [];
  if (opts.previewUrl) elements.push({ type: "button", action_id: ACTION.preview, text: { type: "plain_text", text: "Preview in browser", emoji: false }, url: opts.previewUrl });
  elements.push({ type: "button", action_id: ACTION.changeItems, text: { type: "plain_text", text: "Change the items", emoji: false }, value: "change_items" });
  // The key is new for every generation. The layout name would be the same each time, so an
  // Approve left on an older message would approve whichever draft was newest.
  elements.push({ type: "button", style: "primary", action_id: ACTION.approve, text: { type: "plain_text", text: "Approve", emoji: false }, value: opts.key ?? d.id });
  blocks.push({ type: "actions", block_id: `approve_${d.id}`, elements });
  return blocks;
}

/**
 * What an older draft becomes once a newer one exists. Its buttons go, so a draft that no longer
 * reflects the current selection cannot be approved by scrolling up to it.
 */
export function supersededDraftBlocks(d: Draft): Block[] {
  return [
    { type: "section", text: { type: "mrkdwn", text: `~*This week's newsletter: ${escapeMrkdwn(d.name)}*~\nSubject: ${escapeMrkdwn(d.subject)}` } },
    { type: "context", elements: [{ type: "mrkdwn", text: "A newer draft was generated below. This one can no longer be approved." }] },
  ];
}

export function approvedBlocks(d: Draft, paths: { html: string; md: string }, campaign?: { id: string; editUrl: string; platform: string; audienceName: string; memberCount: number }, held: Item[] = []): Block[] {
  const blocks: Block[] = [
    { type: "section", text: { type: "mrkdwn", text: `*Approved: ${escapeMrkdwn(d.name)}*\nSubject: ${escapeMrkdwn(d.subject)}\nSaved to \`${paths.html}\` and \`${paths.md}\`.` } },
  ];
  // The newsletter itself carries no review label, so the last place to say it is here, above Send.
  if (held.length) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `*This newsletter includes ${held.length} item${held.length === 1 ? "" : "s"} ${REVIEW_LABEL}:*\n${held.map((i) => `• ${escapeMrkdwn(i.title)}${i.hold_note ? ` · on hold: ${escapeMrkdwn(i.hold_note)}` : ""}`).join("\n")}` } });
  }

  if (!campaign) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: "No email platform is configured, so this stops at the file. In production this step creates the campaign for you to send." }] });
    return blocks;
  }

  blocks.push({ type: "section", text: { type: "mrkdwn", text: `A draft campaign is now in ${escapeMrkdwn(campaign.platform)}, addressed to the audience *${escapeMrkdwn(campaign.audienceName)}* (${campaign.memberCount} contact${campaign.memberCount === 1 ? "" : "s"}).\nOpen it in ${escapeMrkdwn(campaign.platform)} to preview or edit it, or send it as is:` } });

  // Preview and edit both happen in the email platform; the destructive action stays the final thing you reach.
  const elements: Block[] = [];
  elements.push({ type: "button", action_id: ACTION.edit, text: { type: "plain_text", text: `Preview or edit in ${campaign.platform}`, emoji: false }, url: campaign.editUrl });
  elements.push({ type: "button", style: "danger", action_id: ACTION.send, text: { type: "plain_text", text: `Send via ${campaign.platform}`, emoji: false }, value: campaign.id, confirm: { title: { type: "plain_text", text: "Send the newsletter?" }, text: { type: "mrkdwn", text: `This sends to *${escapeMrkdwn(campaign.audienceName)}* (${campaign.memberCount}) now. It cannot be unsent.${held.length ? `\n\nIt includes ${held.length} item${held.length === 1 ? "" : "s"} marked for review: ${escapeMrkdwn(trim(held.map((i) => i.title.split(":")[0]).join(", "), 120))}.` : ""}` }, confirm: { type: "plain_text", text: "Send" }, deny: { type: "plain_text", text: "Not yet" } } });
  blocks.push({ type: "actions", block_id: `send_${d.id}`, elements });
  return blocks;
}

export function sentBlocks(platform: string, campaignId: string): Block[] {
  return [{ type: "section", text: { type: "mrkdwn", text: `*Sent.* ${escapeMrkdwn(platform)} is delivering campaign \`${campaignId}\` to the audience now. Check your inbox in a minute or two.` } }];
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
