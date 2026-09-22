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
  type DraftNotes, type ReviewState,
} from "../review/review.js";
import type { RunSummary } from "../run-week.js";
import { DryRunRefusal, isLive } from "../runtime.js";
import { isPastEvent, type Item } from "../schema.js";
import { describeWindow, periodOf, windowsFor } from "../schedule/period.js";
import { whatIsDue } from "../schedule/scheduler.js";
import type { SqliteStorage } from "../storage.js";
import { REVIEW_LABEL } from "../surface/blocks.js";
import { greetingText, missedText, nothingDueText } from "../review/reminder.js";
import { loadCampaigns, loadReview, restoreSession } from "../surface/session.js";
import { isManualItem } from "../manual-events.js";
import { PANEL_MIME, PANEL_URI, panelHtml } from "./panel.js";

export const SERVER_NAME = "volta-newsletter";

/** Once-per-period records for the reminder (storage table schedule_marks). */
const REMINDER_TASK = "claude-reminder";
const MISSED_TASK = "claude-reminder-missed";
/** A greeting that started and never finished (the app closed mid-run) can be retried after this. */
const CLAIM_MS = 10 * 60 * 1000;

/** Read by Claude when it connects. Rules first: they are what keeps the newsletter honest. */
export const INSTRUCTIONS = `Volta's newsletter, reviewed by its curator (Bader) in this chat.

Rules you must follow:
- Never write newsletter text yourself, and never offer to write, rewrite or "fill in" copy for an item. The newsletter is built only from the sources and from Bader's own words. Every item already has what it prints (the "prints:" lines); nothing is missing that you need to supply.
- Lines marked "note to editor (not printed)" are advice for Bader from the source. They never appear in the newsletter. Mention them only as notes for him to consider.
- For edit_item and add_event, pass Bader's words exactly as he gave them. If he asks you to improve or shorten wording, suggest it in chat and only save it once he says to use it, word for word.
- When Bader wants to see the candidates, show list_candidates' result as a list: every group heading, and every item with its [x] or [ ] tick, title, date and its full text as returned. Do not shorten any item's text. You may leave out ids and links. Do not replace the list with a summary or a selection of highlights.
- Keep "MARKED FOR REVIEW" and "On hold:" exactly as returned, so a held item is seen before it is ticked. Show a draft's notes to Bader as returned too.
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

  /** Fetch every source for the period and start (or refresh) its review. Keeps what Bader ticked on a refresh. */
  async function prepareNow(st: ReviewState): Promise<RunSummary> {
    const run = await d.runPeriod();
    const ticked = currentSelection(st);
    startReview(st, {
      candidates: run.candidates, preselectedIds: prepared(st) ? ticked.filter((id) => run.candidates.some((c) => c.item.id === id)) : run.preselected_ids,
      firstWorkday: run.first_workday, period: run.period, timeZone: tz, clockLabel: d.clock.label,
      sourceNotes: run.sources.filter((s) => s.status !== "ok").map((s) => `${s.id}: ${s.status}${s.error ? ` (${s.error})` : ""}`),
    }, CLAUDE_CHANNEL);
    return run;
  }
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
    const run = await prepareNow(st);
    const g = candidateGroups(st);
    const notes = run.sources.filter((s) => s.status !== "ok").map((s) => `- ${s.id}: ${s.status}${s.error ? ` (${s.error})` : ""}`);
    return text([
      `Prepared the ${periodWord} of ${run.period}: ${run.candidates.length} candidates (${g.upcomingEvents.length} upcoming events, ${g.pastEvents.length} past events, ${g.other.length} news and updates), ${currentSelection(st).length} ticked.`,
      ...(notes.length ? ["Sources that need attention:", ...notes] : ["Every source answered."]),
      "Next: call list_candidates and show Bader the list, group by group, with its ticks.",
    ].join("\n"));
  });

  // Called by the scheduled task in Bader's Claude app every morning. The decision and the words are
  // code, not prompt: the first line says what to do (GREETING, MISSED or NOTHING_DUE), and Bader is
  // greeted once per period however many times the task runs, even if two runs overlap.
  server.registerTool("monthly_reminder", {
    title: "Monthly reminder",
    description: `For the scheduled reminder. Decides whether this ${periodWord}'s newsletter is due, prepares it if so, and returns the greeting for Bader. The first line is GREETING, MISSED or NOTHING_DUE; show what follows it exactly as returned.`,
  }, async () => {
    const st = await current();
    const now = d.clock.now();
    const key = st.week!;
    const greeted = Boolean(d.storage.getMark(REMINDER_TASK, key)?.done_at);
    const decision = whatIsDue(now, d.config, { reminderSent: greeted });
    const facts = { cadence: cadenceOf(d.config), periodKey: key, firstWorkday: decision.firstWorkday, reminderTime: d.config.reminder_time };
    const quiet = (why: Parameters<typeof nothingDueText>[1]) => text(`NOTHING_DUE\n${nothingDueText(facts, why)}`);
    switch (decision.reminder) {
      case "not-yet": return quiet("not-yet");
      case "sent": return quiet("already-greeted");
      case "closed": return quiet("closed");
      case "missed": {
        if (d.storage.getMark(MISSED_TASK, key)?.done_at) return quiet("missed-already-said");
        d.storage.claimMark(MISSED_TASK, key, now.toISOString(), CLAIM_MS);
        d.storage.completeMark(MISSED_TASK, key, now.toISOString());
        d.alerter.alert("error", "schedule", `the reminder for ${key} was never shown`, "Bader has been told; the month can still be prepared by asking");
        return text(`MISSED\n${missedText(facts)}`);
      }
      case "due":
      case "due-late": {
        // Two runs at once (a catch-up and the morning run, say): only one greets.
        if (!d.storage.claimMark(REMINDER_TASK, key, now.toISOString(), CLAIM_MS)) return quiet("already-greeted");
        try {
          if (!prepared(st)) await prepareNow(st);
        } catch (e) {
          d.storage.releaseMark(REMINDER_TASK, key);
          throw e;
        }
        const greeting = greetingText({
          ...facts, now, timeZone: tz, late: decision.reminder === "due-late",
          groups: candidateGroups(st), ticked: currentSelection(st), sourceNotes: st.reminder?.input.sourceNotes ?? [],
        });
        d.storage.completeMark(REMINDER_TASK, key, now.toISOString());
        return text(`GREETING\n${greeting}`);
      }
    }
  });

  // The review panel (an MCP App). Hosts that show apps render it for list_candidates; others
  // just use the text, which is complete on its own.
  server.registerResource("review-panel", PANEL_URI, {
    title: "Newsletter review panel", description: "Tick items, edit wording, add events and build the draft.", mimeType: PANEL_MIME,
  }, async () => ({ contents: [{ uri: PANEL_URI, mimeType: PANEL_MIME, text: panelHtml() }] }));

  server.registerTool("list_candidates", {
    title: "List the candidates",
    description: "The candidates in groups (upcoming events, past events, news and updates), each with its id, whether it is ticked, and what Bader has edited. Use the ids with set_selection and edit_item. In apps that support it, this also opens the interactive review panel.",
    inputSchema: { group: z.enum(["all", "upcoming", "past", "other"]).optional().describe("Only one group. Default all.") },
    annotations: { readOnlyHint: true },
    _meta: { ui: { resourceUri: PANEL_URI }, "ui/resourceUri": PANEL_URI },
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
    return { ...text(out.join("\n")), structuredContent: panelState(st, periodWord, tz, isLive(d.env)) };
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
    const notes = draftNotesText(r.notes);
    const panel = { key: r.key, subject: r.draft.subject, previewUrl: r.previewUrl ?? null, notes };
    return { structuredContent: panel, ...text([
      `Draft key: ${r.key}`,
      `Subject: ${r.draft.subject}`,
      r.previewUrl ? `Preview: ${r.previewUrl}` : "Preview: not available (the preview server could not start).",
      `Verified: every name, date and link traces to a source or to Bader.`,
      ...(notes.length ? ["", ...notes] : []),
      "", "----- newsletter text (show verbatim) -----", r.draft.markdown, "----- end -----",
    ].join("\n")) };
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
        case "updated": return text([
          `Approved. This month's campaign ${r.campaign.id} in ${r.campaign.platform} was updated with the new version (still not sent)${r.campaign.editUrl ? `: ${r.campaign.editUrl}` : "."}`,
          "Any changes Bader made directly in Mailchimp have been replaced by this version.",
          `To send: send_campaign with campaign_id ${r.campaign.id} and confirm: true, once Bader says so.`,
        ].join("\n"));
        case "period-sent": return text(`This month's newsletter was already sent (campaign ${r.campaignId}), so this version was saved to ${r.files.html} but not applied anywhere.`, true);
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
  // A held item leads with the same label the Slack list used, so it is seen before it is ticked.
  const bits = [
    `${ticked ? "[x]" : "[ ]"} ${it.requires_review ? `${REVIEW_LABEL} · ` : ""}${it.title}`,
    it.type === "event" ? `${isPastEvent(it) ? "held" : "on"} ${date} ${time}${it.location ? ` at ${it.location}` : ""}` : `${it.type} from ${it.source}, ${date}`,
  ];
  if (it.edited_fields?.length) bits.push(`edited by Bader: ${it.edited_fields.map((f) => EDIT_FIELD_LABEL[f as EditField] ?? f).join(", ")}`);
  if (it.image) bits.push("has an image");
  const lines = [`- ${bits.join(" | ")}`, `  id: ${it.id}`];
  // What the newsletter would print for this item, in full. A founder update prints its points,
  // not its summary: that summary is the write-up's advice to the editor, so it is labelled as
  // such, or it reads as copy that is missing and invites someone to write it.
  if (it.insights?.length) {
    lines.push("  prints:", ...it.insights.map((p) => `    • ${p}`));
    if (it.summary) lines.push(`  note to editor (not printed): ${it.summary}`);
  } else if (it.summary) {
    lines.push(`  prints: ${it.summary}`);
  } else {
    lines.push("  prints: the title only (the source gave no description)");
  }
  if (it.requires_review && it.hold_note) lines.push(`  On hold: ${it.hold_note}`);
  for (const n of it.editor_notes ?? []) lines.push(`  note to editor (not printed): ${n}`);
  lines.push(`  link: ${it.link}${it.message_link && it.message_link !== it.link ? ` | Slack message: ${it.message_link}` : ""}`);
  return lines.join("\n");
}

/**
 * What Bader should know about the picked items that the newsletter will not say, worded and laid
 * out as the Slack draft notes were: held items first, then the write-ups' notes to the editor,
 * then what he changed. Empty when there is nothing to say.
 */
export function draftNotesText(notes: DraftNotes): string[] {
  const held = notes.held;
  return [
    ...(held.length ? [
      `**${held.length} selected item${held.length === 1 ? " is" : "s are"} ${REVIEW_LABEL}.** ${held.length === 1 ? "It is" : "They are"} in this draft because you ticked ${held.length === 1 ? "it" : "them"}. Check the hold still applies before you send.`,
      ...held.map((h) => `• **${h.title}**${h.hold_note ? ` · on hold: ${h.hold_note}` : ""}`),
    ] : []),
    ...(notes.editorNotes.length ? [
      ...(held.length ? [""] : []),
      "**Notes to the editor from the write-ups** (not in the newsletter)",
      ...notes.editorNotes.flatMap((n) => [`**${n.title}**`, ...n.notes.map((x) => `      • ${x}`)]),
    ] : []),
    ...(notes.edited.length ? [
      ...(held.length || notes.editorNotes.length ? [""] : []),
      "**Changed by you**",
      ...notes.edited.map((e) => `• **${e.title}**: ${e.fields.join(", ")}`),
    ] : []),
  ];
}

/** One candidate as the review panel shows it. */
export type PanelItem = {
  id: string;
  title: string;
  ticked: boolean;
  isEvent: boolean;
  /** How the date reads in the list: "Thu Oct 22, 6:00 pm" for events, "2026-09-14" otherwise. */
  when: string;
  dateLocal: string;
  timeLocal: string;
  location?: string;
  held: boolean;
  holdNote?: string;
  /** What the newsletter prints for it, in full: its points, or its description. */
  prints: string[];
  hasPoints: boolean;
  /** Advice for the curator that is never printed. */
  notes: string[];
  edited: string[];
  manual: boolean;
  image?: string;
  link: string;
};

export type PanelState = {
  periodLabel: string;
  dryRun: boolean;
  ticked: number;
  total: number;
  groups: Array<{ key: "upcoming" | "past" | "other"; title: string; items: PanelItem[] }>;
};

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS: Record<string, string> = { sunday: "Sun", monday: "Mon", tuesday: "Tue", wednesday: "Wed", thursday: "Thu", friday: "Fri", saturday: "Sat" };

export function panelItem(it: Item, ticked: boolean, timeZone: string): PanelItem {
  const p = partsInZone(new Date(it.date), timeZone);
  const pad = (n: number) => String(n).padStart(2, "0");
  const dateLocal = `${p.year}-${pad(p.month)}-${pad(p.day)}`;
  const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  const isEvent = it.type === "event";
  const when = isEvent
    ? `${isPastEvent(it) ? "held " : ""}${DAYS[p.weekday] ?? ""} ${MONTHS[p.month - 1]!.slice(0, 3)} ${p.day}, ${h12}:${pad(p.minute)} ${p.hour < 12 ? "am" : "pm"}`
    : dateLocal;
  const hasPoints = Boolean(it.insights?.length);
  const prints = hasPoints ? it.insights! : it.summary ? [it.summary] : [];
  const notes = [...(hasPoints && it.summary ? [it.summary] : []), ...(it.editor_notes ?? [])];
  return {
    id: it.id, title: it.title, ticked, isEvent, when, dateLocal, timeLocal: `${pad(p.hour)}:${pad(p.minute)}`,
    ...(it.location ? { location: it.location } : {}), held: it.requires_review, ...(it.hold_note ? { holdNote: it.hold_note } : {}),
    prints, hasPoints, notes, edited: it.edited_fields ?? [], manual: isManualItem(it), ...(it.image ? { image: it.image } : {}), link: it.link,
  };
}

/** Everything the review panel draws: the period, the mode and the three groups. */
export function panelState(st: ReviewState, periodWord: string, timeZone: string, live: boolean): PanelState {
  const g = candidateGroups(st);
  const ticked = new Set(currentSelection(st));
  const items = (list: RankedItem[]) => list.map((c) => panelItem(c.item, ticked.has(c.item.id), timeZone));
  const key = st.week ?? "";
  const monthly = /^\d{4}-\d{2}$/.test(key);
  const periodLabel = monthly ? `${MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}` : `Week of ${key}`;
  return {
    periodLabel, dryRun: !live, ticked: ticked.size, total: st.candidates.length,
    groups: [
      { key: "upcoming", title: "Upcoming events", items: items(g.upcomingEvents) },
      { key: "past", title: periodWord === "month" ? "Last month's events" : "Past events", items: items(g.pastEvents) },
      { key: "other", title: "News and updates", items: items(g.other) },
    ],
  };
}
