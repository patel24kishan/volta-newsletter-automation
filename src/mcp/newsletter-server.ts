/**
 * The newsletter as tools Claude can call, so the curator reviews it in a chat instead of Slack.
 *
 * Every tool is a thin layer over the review core (src/review/review.ts), which already holds the
 * rules: what is selected, how a draft is built and verified, when an email may be created or
 * sent. This file only turns those results into text Claude can read back.
 *
 * What Claude may not do, by construction rather than by trust:
 *   - No tool takes newsletter text from Claude. A draft is built from item ids, approved by its
 *     key and sent by its campaign id. The only free text accepted is the curator's own: the
 *     fields of an event they add and the wording of an edit, which the instructions require to be
 *     passed verbatim, and which the Claude app shows the curator before each call runs.
 *   - Creating or sending an email needs ALLOW_LIVE=1 (CLAUDE.md section 4), and sending also needs
 *     `confirm: true`. In dry-run those tools say what they would have done and do nothing.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Alerter } from "../alerts.js";
import { partsInZone } from "../clock.js";
import type { Clock } from "../clock.js";
import { cadenceOf, type Config } from "../config.js";
import type { RankedItem } from "../pipeline/rank.js";
import type { Publisher } from "../publish/types.js";
import { EDIT_FIELD_LABEL, EDIT_FIELDS, type EditField } from "../review/edits.js";
import {
  addEvent, approve, buildDraft, CLAUDE_CHANNEL, candidateGroups, currentDraft, currentSelection, editItem, send, setSelection, startReview,
  type ReviewState,
} from "../review/review.js";
import type { RunSummary } from "../run-week.js";
import { DryRunRefusal, isLive } from "../runtime.js";
import { isPastEvent, type Item } from "../schema.js";
import { describeWindow, periodOf, windowsFor } from "../schedule/period.js";
import { whatIsDue } from "../schedule/scheduler.js";
import type { SqliteStorage } from "../storage.js";
import { loadCampaigns, loadReview, restoreSession } from "../surface/session.js";

export const SERVER_NAME = "volta-newsletter";

/** Read by Claude when it connects. Rules first: they are what keeps the newsletter honest. */
export const INSTRUCTIONS = `Volta's newsletter, reviewed by its curator (Bader) in this chat.

Rules you must follow:
- Never write newsletter text yourself. The newsletter is built only from the sources and from Bader's own words.
- For edit_item and add_event, pass Bader's words exactly as he gave them. If he asks you to improve or shorten wording, suggest it in chat and only save it once he says to use it, word for word.
- Show a built draft's text exactly as returned, and give him the preview link. Do not summarise the draft in place of showing it.
- Ask Bader before approve_draft and before send_campaign. Sending cannot be undone.

Usual order: newsletter_status, then prepare_month if the month is not prepared, then list_candidates, set_selection, edit_item / add_event as he asks, build_draft (repeat after any change), approve_draft, send_campaign.`;

export interface NewsletterDeps {
  config: Config;
  clock: Clock;
  storage: SqliteStorage;
  alerter: Alerter;
  outDir: string;
  env: NodeJS.ProcessEnv;
  /** Fetches every source for the period and ranks the candidates. Injected so tests need no network. */
  runPeriod: () => Promise<RunSummary>;
  publisher?: Publisher;
  /** The audience the platform will send to, read once at startup, for the approval message. */
  audience?: { audienceName: string; memberCount: number };
  /** Started on first use, so a chat that never builds a draft never opens a port. */
  preview?: () => Promise<{ put(html: string, id?: string): string } | undefined>;
}

type ToolText = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
const text = (s: string, isError = false): ToolText => ({ content: [{ type: "text", text: s }], ...(isError ? { isError: true } : {}) });

export function createNewsletterServer(d: NewsletterDeps): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: "1.0.0" }, { instructions: INSTRUCTIONS });
  const tz = d.config.timezone;
  const periodWord = cadenceOf(d.config) === "monthly" ? "month" : "week";
  let review: ReviewState | undefined;
  let previewTried = false;
  let previewHandle: { put(html: string, id?: string): string } | undefined;

  /** The review for the period the clock is in: the one in memory, or the saved one, or a new one. */
  async function current(): Promise<ReviewState> {
    const key = periodOf(d.clock.now(), d.config).key;
    if (review?.week === key) return review;
    const st: ReviewState = {
      candidates: [], timeZone: tz, outDir: d.outDir, drafts: new Map(), selections: new Map(), env: d.env, campaigns: new Set(),
      now: () => d.clock.now(), layout: d.config.draft_layout, session: d.storage, edits: d.storage, storage: d.storage, week: key,
      ...(d.config.cadence ? { cadence: d.config.cadence } : {}),
      ...(d.publisher ? { publisher: d.publisher } : {}),
      ...(d.audience ? { audience: d.audience } : {}),
    };
    const manual = d.config.sources.find((s) => s.kind === "manual" && s.enabled);
    if (manual?.fallback_link) st.manualSource = { ...manual, fallback_link: manual.fallback_link };
    loadCampaigns(st, d.storage);
    const saved = loadReview(d.storage, key);
    if (saved && "snapshot" in saved) restoreSession(st, saved.snapshot);
    if (saved && "error" in saved) d.alerter.alert("error", "session", `the saved review for ${key} could not be read: ${saved.error}`, "prepare_month with force to start it again");
    review = st;
    return st;
  }

  async function withPreview(st: ReviewState): Promise<void> {
    if (!d.preview) return;
    if (!previewTried) {
      previewTried = true;
      previewHandle = await d.preview().catch(() => undefined);
    }
    if (previewHandle && st.preview !== previewHandle) {
      st.preview = previewHandle;
      // Pages from before a restart are served again at the links already given.
      for (const r of st.drafts.values()) if (r.previewId) previewHandle.put(r.draft.html, r.previewId);
    }
  }

  const prepared = (st: ReviewState) => Boolean(st.reminder);
  const notPrepared = () => text(`This ${periodWord}'s newsletter has not been prepared yet. Call prepare_month first.`, true);

  server.registerTool("newsletter_status", {
    title: "Newsletter status",
    description: `Where this ${periodWord}'s newsletter stands: its period, when it is due, whether sources have been fetched, what is ticked, the draft and campaign, and whether this is a dry run.`,
    annotations: { readOnlyHint: true },
  }, async () => {
    const st = await current();
    const now = d.clock.now();
    const due = whatIsDue(now, d.config, { reminderSent: prepared(st) });
    const w = windowsFor(now, d.config);
    const draft = currentDraft(st);
    const lines = [
      `Period: ${st.week} (${cadenceOf(d.config)}). First workday: ${due.firstWorkday.weekday} ${due.firstWorkday.date}${due.firstWorkday.skipped.length ? ` (skipped ${due.firstWorkday.skipped.join("; ")})` : ""}.`,
      `Due: ${due.reminder === "sent" ? "prepared" : due.reminder}.`,
      prepared(st) ? `Prepared: ${st.candidates.length} candidates, ${currentSelection(st).length} ticked.` : "Not prepared yet: call prepare_month.",
      `Reads: news and posts ${describeWindow(w.content, tz)}; upcoming events ${describeWindow(w.upcoming, tz)}${w.past ? `; past events ${describeWindow(w.past, tz)}` : ""}.`,
      draft ? `Draft: "${draft.draft.subject}" (key ${draft.key})${draft.campaign ? `, campaign ${draft.campaign.id} in ${draft.campaign.platform}: ${draft.campaign.editUrl}` : ", not approved yet"}.` : "Draft: none built yet.",
      `Mode: ${isLive(d.env) ? "LIVE: approve creates a real campaign and send emails the audience." : "dry run: nothing is created in or sent from the email platform."}`,
      `Email platform: ${d.publisher ? d.publisher.platform : "not configured (approve saves the file only)"}.`,
    ];
    return text(lines.join("\n"));
  });

  server.registerTool("prepare_month", {
    title: `Prepare this ${periodWord}'s newsletter`,
    description: `Fetch every source for this ${periodWord} and list the candidates. Does nothing if already prepared, unless force is true (which fetches again; Bader's edits and added events are kept).`,
    inputSchema: { force: z.boolean().optional().describe("Fetch again even though this period was already prepared.") },
  }, async ({ force }) => {
    const st = await current();
    if (prepared(st) && !force) return text(`Already prepared: ${st.candidates.length} candidates. Use list_candidates, or force: true to fetch again.`);
    const run = await d.runPeriod();
    const ticked = currentSelection(st);
    startReview(st, {
      candidates: run.candidates, preselectedIds: prepared(st) ? ticked.filter((id) => run.candidates.some((c) => c.item.id === id)) : run.preselected_ids,
      firstWorkday: run.first_workday, period: run.period, timeZone: tz, clockLabel: d.clock.label,
      sourceNotes: run.sources.filter((s) => s.status !== "ok").map((s) => `${s.id}: ${s.status}${s.error ? ` (${s.error})` : ""}`),
    }, CLAUDE_CHANNEL);
    const g = candidateGroups(st);
    const notes = run.sources.filter((s) => s.status !== "ok").map((s) => `- ${s.id}: ${s.status}${s.error ? ` (${s.error})` : ""}`);
    return text([
      `Prepared the ${periodWord} of ${run.period}: ${run.candidates.length} candidates (${g.upcomingEvents.length} upcoming events, ${g.pastEvents.length} past events, ${g.other.length} news and updates), ${currentSelection(st).length} ticked.`,
      ...(notes.length ? ["Sources that need attention:", ...notes] : ["Every source answered."]),
      "Next: list_candidates.",
    ].join("\n"));
  });

  server.registerTool("list_candidates", {
    title: "List the candidates",
    description: "The candidates in groups (upcoming events, past events, news and updates), each with its id, whether it is ticked, and what Bader has edited. Use the ids with set_selection and edit_item.",
    inputSchema: { group: z.enum(["all", "upcoming", "past", "other"]).optional().describe("Only one group. Default all.") },
    annotations: { readOnlyHint: true },
  }, async ({ group }) => {
    const st = await current();
    if (!prepared(st)) return notPrepared();
    const g = candidateGroups(st);
    const ticked = new Set(currentSelection(st));
    const out: string[] = [`${ticked.size} of ${st.candidates.length} ticked. [x] = ticked.`];
    const section = (title: string, list: RankedItem[]) => {
      out.push("", `## ${title} (${list.length})`);
      if (!list.length) out.push("None.");
      for (const c of list) out.push(describeItem(c.item, ticked.has(c.item.id), tz));
    };
    if (!group || group === "all" || group === "upcoming") section("Upcoming events", g.upcomingEvents);
    if (!group || group === "all" || group === "past") section("Past events (last month)", g.pastEvents);
    if (!group || group === "all" || group === "other") section("News and updates", g.other);
    return text(out.join("\n"));
  });

  server.registerTool("set_selection", {
    title: "Tick or untick items",
    description: "Change which candidates go into the newsletter, by id: replace the whole selection, or tick and untick some.",
    inputSchema: {
      select: z.array(z.string()).optional().describe("Replace the selection with exactly these ids."),
      tick: z.array(z.string()).optional().describe("Add these ids to the selection."),
      untick: z.array(z.string()).optional().describe("Remove these ids from the selection."),
    },
  }, async ({ select, tick, untick }) => {
    const st = await current();
    if (!prepared(st)) return notPrepared();
    let ids = select ?? currentSelection(st);
    if (tick) ids = [...ids, ...tick];
    if (untick) ids = ids.filter((id) => !untick.includes(id));
    const r = setSelection(st, ids);
    const titles = new Map(st.candidates.map((c) => [c.item.id, c.item.title]));
    return text([
      `${r.selected.length} ticked: ${r.selected.map((id) => titles.get(id)).join("; ") || "nothing"}.`,
      ...(r.unknown.length ? [`Not candidates, ignored: ${r.unknown.join(", ")}.`] : []),
      "Rebuild with build_draft to see the change.",
    ].join("\n"), r.unknown.length > 0 && r.selected.length === 0);
  });

  server.registerTool("add_event", {
    title: "Add an event",
    description: "Add an event Bader knows about that no source lists. Use his words exactly. It is ticked straight away.",
    inputSchema: {
      title: z.string().describe("Event title, as Bader gave it."),
      date: z.string().describe("YYYY-MM-DD, in Halifax time."),
      time: z.string().describe("HH:MM, 24-hour, in Halifax time."),
      location: z.string().optional(),
      description: z.string().optional().describe("As Bader gave it. Leave out rather than write one."),
      link: z.string().optional().describe("Full https:// link, if there is one."),
      image: z.string().optional().describe("An https:// image link, or the full path of a .jpg/.png/.gif on this computer."),
    },
  }, async (f) => {
    const st = await current();
    if (!prepared(st)) return notPrepared();
    if (!st.manualSource) return text('Adding events is not set up: the config has no enabled "manual" source.', true);
    const r = addEvent(st, { title: f.title, date: f.date, time: f.time, ...(f.location ? { location: f.location } : {}), ...(f.description ? { description: f.description } : {}), ...(f.link ? { link: f.link } : {}), ...(f.image ? { image: f.image } : {}) });
    if ("errors" in r) return text(`Not added. Fix these and try again:\n${Object.entries(r.errors).map(([k, v]) => `- ${k}: ${v}`).join("\n")}`, true);
    return text(`Added and ticked:\n${describeItem(r.item, true, tz)}\nRebuild with build_draft to see it in the newsletter.`);
  });

  server.registerTool("edit_item", {
    title: "Change an item's wording",
    description: `Change one field of a candidate to Bader's exact words, or clear his change to go back to the source. Fields: ${EDIT_FIELDS.map((f) => `${f} (${EDIT_FIELD_LABEL[f]})`).join(", ")}. title and image only on events he added. starts_at is YYYY-MM-DD HH:MM in Halifax time.`,
    inputSchema: {
      item_id: z.string(),
      field: z.enum(EDIT_FIELDS),
      text: z.string().optional().describe("Bader's words, exactly. Leave out when clearing."),
      clear: z.boolean().optional().describe("Remove Bader's change and use the source's text again."),
    },
  }, async ({ item_id, field, text: value, clear }) => {
    const st = await current();
    if (!prepared(st)) return notPrepared();
    if (!clear && value === undefined) return text("Give the new text, or clear: true to go back to the source.", true);
    const r = editItem(st, item_id, field as EditField, clear ? null : value!);
    if ("error" in r) return text(`Not changed: ${r.error}`, true);
    return text(`${clear ? "Back to the source's" : "Changed the"} ${EDIT_FIELD_LABEL[field as EditField]}:\n${describeItem(r.item, currentSelection(st).includes(item_id), tz)}\nRebuild with build_draft to see it in the newsletter.`);
  });

  server.registerTool("build_draft", {
    title: "Build the newsletter",
    description: "Build and verify the newsletter from what is ticked, with Bader's edits. Returns the text to show him verbatim, a preview link, and the draft key for approve_draft. Build again after any change.",
  }, async () => {
    const st = await current();
    if (!prepared(st)) return notPrepared();
    await withPreview(st);
    const r = buildDraft(st, d.alerter);
    if (!r.ok && r.reason === "nothing-selected") return text("Nothing is ticked. Tick at least one item with set_selection, then build again.", true);
    if (!r.ok) return text(`The draft did not pass verification, so it was not kept (the previous draft, if any, is still the one to approve):\n${r.violations.map((v) => `- ${v.kind}: ${v.value}`).join("\n")}`, true);
    const notes = [
      ...r.notes.edited.map((e) => `- Edited by Bader: ${e.title} (${e.fields.join(", ")})`),
      ...r.notes.held.map((h) => `- On hold at the source: ${h.title}${h.hold_note ? ` (${h.hold_note})` : ""}. Check the hold still applies before sending.`),
      ...r.notes.editorNotes.flatMap((n) => n.notes.map((x) => `- Note to the editor about ${n.title}: ${x}`)),
    ];
    return text([
      `Draft key: ${r.key}`,
      `Subject: ${r.draft.subject}`,
      r.previewUrl ? `Preview: ${r.previewUrl}` : "Preview: not available (the preview server could not start).",
      `Verified: every name, date and link traces to a source or to Bader.`,
      ...(notes.length ? ["", "For Bader (not in the newsletter):", ...notes] : []),
      "", "----- newsletter text (show verbatim) -----", r.draft.markdown, "----- end -----",
    ].join("\n"));
  });

  server.registerTool("approve_draft", {
    title: "Approve the newsletter",
    description: "Approve the draft with this key: saves it, and in live mode creates the email campaign (not sent). Ask Bader first.",
    inputSchema: { draft_key: z.string().describe("From build_draft.") },
  }, async ({ draft_key }) => {
    const st = await current();
    try {
      const r = await approve(st, draft_key);
      switch (r.status) {
        case "missing": return text("That draft is no longer current (a newer one was built). Build again and approve the new key.", true);
        case "saved": return text(`Approved and saved to ${r.files.html}. No email platform is configured, so nothing was created there.`);
        case "failed": return text(`Saved to ${r.files.html}, but creating the ${r.platform} campaign failed: ${r.error.message}`, true);
        case "already": return text(`Already approved. Campaign ${r.campaign.id} in ${r.campaign.platform}: ${r.campaign.editUrl}`);
        case "created": return text([
          `Approved. Campaign ${r.campaign.id} created in ${r.campaign.platform} (not sent): ${r.campaign.editUrl}`,
          `Audience: ${r.audience.audienceName} (${r.audience.memberCount} contacts).`,
          ...(r.held.length ? [`It includes ${r.held.length} item(s) the source put on hold: ${r.held.map((h) => h.title).join("; ")}. Check before sending.`] : []),
          `To send: send_campaign with campaign_id ${r.campaign.id} and confirm: true, once Bader says so.`,
        ].join("\n"));
      }
    } catch (e) {
      if (e instanceof DryRunRefusal) return text(`Dry run: the draft is saved in ${d.outDir}, but no campaign was created. Start the server with ALLOW_LIVE=1 to create one.`);
      throw e;
    }
  });

  server.registerTool("send_campaign", {
    title: "Send the newsletter",
    description: "Send an approved campaign to the audience. Cannot be undone. Only when Bader has said to send; confirm must be true.",
    inputSchema: { campaign_id: z.string(), confirm: z.boolean().describe("true only when Bader has explicitly said to send.") },
    annotations: { destructiveHint: true },
  }, async ({ campaign_id, confirm }) => {
    if (!confirm) return text("Not sent: confirm must be true, and only once Bader has said to send.", true);
    const st = await current();
    try {
      const r = await send(st, campaign_id);
      if (r.status === "sent") return text(`Sent via ${r.platform}.`);
      const why = { "no-platform": "no email platform is configured", "already-sent": "that campaign was already sent; it will not be sent twice", unknown: "that campaign was not approved here" }[r.status];
      return text(`Not sent: ${why}.`, true);
    } catch (e) {
      if (e instanceof DryRunRefusal) return text("Dry run: nothing was sent. Start the server with ALLOW_LIVE=1 to send.");
      throw e;
    }
  });

  return server;
}

/** One candidate as a line Claude can read back: id, tick, title, when and where, and what was edited. */
export function describeItem(it: Item, ticked: boolean, timeZone: string): string {
  const p = partsInZone(new Date(it.date), timeZone);
  const date = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
  const time = `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
  const bits = [
    `${ticked ? "[x]" : "[ ]"} ${it.title}`,
    it.type === "event" ? `${isPastEvent(it) ? "held" : "on"} ${date} ${time}${it.location ? ` at ${it.location}` : ""}` : `${it.type} from ${it.source}, ${date}`,
  ];
  if (it.requires_review) bits.push(`ON HOLD${it.hold_note ? ` (${it.hold_note})` : ""}`);
  if (it.edited_fields?.length) bits.push(`edited by Bader: ${it.edited_fields.map((f) => EDIT_FIELD_LABEL[f as EditField] ?? f).join(", ")}`);
  if (it.image) bits.push("has an image");
  const lines = [`- ${bits.join(" | ")}`, `  id: ${it.id}`];
  if (it.summary) lines.push(`  ${it.summary.length > 200 ? `${it.summary.slice(0, 197)}...` : it.summary}`);
  lines.push(`  link: ${it.link}${it.message_link && it.message_link !== it.link ? ` | Slack message: ${it.message_link}` : ""}`);
  return lines.join("\n");
}
