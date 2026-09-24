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
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { describeSources, effectiveSources, toSourceConfig } from "../sources/curator-sources.js";
import { ADDABLE_KINDS, configKeeps, credentialNote, filterTerms, filterWords, KIND_LABEL, readsWhat, sourceFromFields, sourceLine } from "./source-tools.js";
import { droppedCount, explainSourceNote, formatSourceNote, parseSourceNote, sourceLink, worthSaying, type SourceNote } from "../sources/source-notes.js";
import { keepRelevant } from "../sources/relevance.js";
import type { Alerter } from "../alerts.js";
import { partsInZone } from "../clock.js";
import type { Clock } from "../clock.js";
import { cadenceOf, type Config, type SourceConfig } from "../config.js";
import { fetcherFor } from "../fetchers/index.js";
import type { RankedItem } from "../pipeline/rank.js";
import type { Publisher } from "../publish/types.js";
import { EDIT_FIELD_LABEL, EDIT_FIELDS, type EditField } from "../review/edits.js";
import {
  addEvent, approve, buildDraft, CLAUDE_CHANNEL, candidateGroups, currentDraft, currentSelection, editItem, removeEvent, send, setSelection, startReview,
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
import { PANEL_MIME, PANEL_URI, panelHtml, PREVIEW_URI } from "./panel.js";

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
- For add_source, use only what Bader gives you: an address, search words, or a Slack channel link. A source is somewhere to read from and a filter, never copy; never invent a feed and never add one he did not name.
- When a source could not be read, tell him what it needs (a token, an invite to the channel, a sign-in) and never let its empty section pass as "nothing happened this month".

Usual order: newsletter_status, then prepare_month if the month is not prepared, then list_candidates, set_selection, edit_item / add_event as he asks, build_draft (repeat after any change), approve_draft, send_campaign.

Events he added himself: he corrects them, he does not add them again. Adding the same event twice puts it in the newsletter twice.
- "add the link to X", "I forgot the link", "fix the link", "change the date of X", "it is at Volta" -> edit_item on that event. Never add_event again to correct one.
- "remove that event", "delete that event", "that one was a mistake" -> remove_event, after he has said to. Only events he added; anything from a source is unticked with set_selection instead.

Sources: Bader says these in a few words. Take them as they are, and ask only for what is missing.
- "sources", "list sources", "what do we read?" -> list_sources.
- "add source", "add feed", "add calendar", "add channel", or a link on its own -> add_source. Ask for the address, the search words, or the channel link, whichever the kind needs.
- "turn off X", "pause X", "turn on X" -> set_source. "only keep X from that", "change the keywords" -> set_source with keywords.
- "remove source", "delete source", "stop reading X" -> remove_source, after he has said to.
- "refresh", "refresh this month", "fetch again" -> prepare_month with force.
A source added now is read when the period is next prepared: say so, and offer to refresh when he wants its items straight away.`;

export interface NewsletterDeps {
  config: Config;
  clock: Clock;
  storage: SqliteStorage;
  alerter: Alerter;
  outDir: string;
  env: NodeJS.ProcessEnv;
  /** Fetches every source for the period and ranks the candidates. Injected so tests need no network. */
  runPeriod: () => Promise<RunSummary>;
  /** How a single source is read when add_source checks it. Injected so tests need no network. */
  fetchText?: (url: string) => Promise<string>;
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
    const manual = effectiveSources(d.config, d.storage).find((s) => s.kind === "manual" && s.enabled);
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
      // A refresh keeps what he ticked, except for anything now marked for review: that label
      // exists to be seen before an item is used, and a kept tick would hide it.
      candidates: run.candidates,
      preselectedIds: prepared(st)
        ? ticked.filter((id) => run.candidates.some((c) => c.item.id === id && !c.item.requires_review))
        : run.preselected_ids,
      firstWorkday: run.first_workday, period: run.period, timeZone: tz, clockLabel: d.clock.label,
      // Every source, warnings included: a later surface cannot tell a quiet month from a month
      // whose items were all thrown away unless the numbers travel with the note.
      sourceNotes: run.sources
        .filter((s) => s.status !== "ok" || (s.warnings ?? []).some(worthSaying))
        .map((s) => formatSourceNote({ id: s.id, status: s.status, ...(s.error ? { error: s.error } : {}), warnings: s.warnings ?? [] })),
    }, CLAUDE_CHANNEL);
    return run;
  }

  /**
   * Everything about a source Bader should know, by source id: the name he gave it, what kind it
   * is, what it keeps, and where to go. One map, so every surface says the same thing about the
   * same source instead of each building its own half of the sentence.
   */
  function sourceFacts(): Record<string, { name: string; kind: string; keeps: string; keepsWords: string; link?: string }> {
    const facts: Record<string, { name: string; kind: string; keeps: string; keepsWords: string; link?: string }> = {};
    const mine = new Map(d.storage.listCuratorSources().map((r) => [r.id, r]));
    for (const src of describeSources(d.config, d.storage).sources) {
      const row = mine.get(src.id);
      const link = sourceLink(src);
      facts[src.id] = {
        name: row?.label || src.id,
        kind: src.kind,
        keeps: row ? filterWords(row, d.config, src.kind) : configKeeps(src.kind, d.config),
        keepsWords: filterTerms(row ?? { keywords: [], filtered: false }, d.config, src.kind),
        ...(link ? { link } : {}),
      };
    }
    return facts;
  }

  /** Where Bader goes for each source, by id. */
  function linksBySource(): Record<string, string> {
    const links: Record<string, string> = {};
    for (const [id, f] of Object.entries(sourceFacts())) if (f.link) links[id] = f.link;
    return links;
  }

  /**
   * What to tell Bader about the sources, from notes in either shape: a run's rows, or the
   * "id: status (error)" strings a saved review kept. Failures carry their remedy; a source that
   * answered but gave unusable items is called out too, since that is how empty entries reach an email.
   */
  function attentionLines(notes: Array<SourceNote>): string[] {
    const facts = sourceFacts();
    const lines: string[] = [];
    for (const n of notes) {
      const f = facts[n.id];
      // The manual source is where Bader's own events live: "found nothing" every quiet month is noise.
      if (f?.kind === "manual" && n.status === "empty") continue;
      const o = { periodWord, ...(f ? { name: f.name, kind: f.kind, keeps: f.keeps, keepsWords: f.keepsWords, ...(f.link ? { link: f.link } : {}) } : {}) };
      const said = (n.warnings ?? []).filter(worthSaying);
      if (n.status !== "ok") {
        lines.push(`- ${explainSourceNote(n, o)}`);
        // The explanation already carried the count; repeating the raw warning says it twice.
        continue;
      }
      // It answered and gave items: only worth a line if what it gave is unusable. Two warnings
      // can say the same thing in his words ("gave only links"), and he should read it once.
      const seen = new Set<string>();
      for (const w of said) {
        const plain = plainWarning(w);
        if (seen.has(plain)) continue;
        seen.add(plain);
        lines.push(`- ${o.name ?? n.id} answered, but ${plain}${f?.link ? ` (${f.link})` : ""}`);
      }
    }
    return lines;
  }

  /** A run's own rows as notes, warnings included. */
  const notesOf = (run: RunSummary): SourceNote[] =>
    run.sources.map((s) => ({ id: s.id, status: s.status, ...(s.error ? { error: s.error } : {}), warnings: s.warnings ?? [] }));

  /** Notes a saved review kept as strings ("volta-linkedin: failed (...)"). */
  const savedNotes = (st: ReviewState): SourceNote[] => (st.reminder?.input.sourceNotes ?? []).map((n: string) => parseSourceNote(n));

  /** A fetcher's warning as something Bader can read. */
  function plainWarning(w: string): string {
    if (/no JSON-LD|fell back|came with no text/i.test(w)) return "it gave only links, not what the posts say. Those items are marked for review rather than ticked: check what they are about before you use them.";
    if (/markup may have changed/i.test(w)) return "nothing could be read from the page this time. Tell the maintainer if it keeps happening.";
    if (/link\(s\) could not be fetched/i.test(w)) return "some items have no link back to their Slack message.";
    if (/more messages in the window than could be read/i.test(w)) return "it had more messages than could be read in one go, so older ones this month may be missing.";
    if (/may be missing/i.test(w)) return "its public page did not reach back far enough, so earlier posts this month may be missing.";
    if (/were skipped/i.test(w)) return "some items had nothing to link to, so they were left out.";
    if (/unknown TZID/i.test(w)) return "an event gave a timezone it does not recognise, so check that event's time.";
    return w;
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
    description: `Fetch every source for this ${periodWord} and list the candidates. Does nothing if already prepared, unless force is true (which fetches again; Bader's edits and added events are kept). "Refresh" or "fetch again" means force.`,
    inputSchema: { force: z.boolean().optional().describe("Fetch again even though this period was already prepared.") },
  }, async ({ force }) => {
    const st = await current();
    if (prepared(st) && !force) return text(`Already prepared: ${st.candidates.length} candidates. Use list_candidates, or force: true to fetch again.`);
    const run = await prepareNow(st);
    const g = candidateGroups(st);
    const notes = attentionLines(notesOf(run));
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
          groups: candidateGroups(st), ticked: currentSelection(st), sourceNotes: st.reminder?.input.sourceNotes ?? [], sourceLines: attentionLines(savedNotes(st)),
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

  // The built newsletter itself, so the panel can show it without the host having to open a
  // loopback address. Empty until something has been built; the panel then falls back to the link.
  server.registerResource("current-draft", PREVIEW_URI, {
    title: "This month's newsletter, as it will look", description: "The rendered draft, for the review panel to show in place.", mimeType: "text/html",
  }, async () => {
    const st = await current();
    const draft = currentDraft(st);
    return { contents: [{ uri: PREVIEW_URI, mimeType: "text/html", text: draft?.draft.html ?? "" }] };
  });

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
      for (const c of list) out.push(describeItem(c.item, ticked.has(c.item.id), tz, d.clock.now()));
    };
    if (!group || group === "all" || group === "upcoming") section("Upcoming events", g.upcomingEvents);
    if (!group || group === "all" || group === "past") section(periodWord === "month" ? "Last month's events" : "Past events", g.pastEvents);
    if (!group || group === "all" || group === "other") section("News and updates", g.other);
    return { ...text(out.join("\n")), structuredContent: panelState(st, periodWord, tz, isLive(d.env), group) };
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
    // Through candidateGroups, which applies his edits, so an item he renamed is read back to him
    // under his own name rather than the one its source gave it.
    const g = candidateGroups(st);
    const titles = new Map([...g.upcomingEvents, ...g.pastEvents, ...g.other].map((c) => [c.item.id, c.item.title]));
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
    return text(`${clear ? "Back to the source's" : "Changed the"} ${EDIT_FIELD_LABEL[field as EditField]}:\n${describeItem(r.item, currentSelection(st).includes(item_id), tz, d.clock.now())}\nRebuild with build_draft to see it in the newsletter.`);
  });

  server.registerTool("remove_event", {
    title: "Remove an event Bader added",
    description: "Forget an event Bader added himself, when it was a mistake or a duplicate. Only his own events; anything from a source is unticked instead. Ask him first. He says: remove that event, delete that event.",
    inputSchema: {
      item_id: z.string().describe("The event's id, as list_candidates shows it."),
      confirm: z.boolean().describe("true only when Bader has said to remove it."),
    },
    annotations: { destructiveHint: true },
  }, async ({ item_id, confirm }) => {
    const st = await current();
    if (!prepared(st)) return notPrepared();
    if (!confirm) return text("Not removed: confirm must be true, and only once Bader has said to remove it.", true);
    const r = removeEvent(st, item_id);
    if ("error" in r) return text(`Not removed: ${r.error}`, true);
    return text([
      `Removed "${r.removed.title}". It is gone from this ${periodWord}'s list and will not come back on the next run.`,
      "Anything already approved or sent is untouched. Rebuild with build_draft to see the newsletter without it.",
    ].join("\n"));
  });

  server.registerTool("build_draft", {
    title: "Build the newsletter",
    description: "Build and verify the newsletter from what is ticked, with Bader's edits. Returns the text to show him verbatim, a preview link, and the draft key for approve_draft. Build again after any change.",
  }, async () => {
    const st = await current();
    if (!prepared(st)) return notPrepared();
    await withPreview(st);
    const r = buildDraft(st, d.alerter);
    if (!r.ok && r.reason === "nothing-selected") {
      // Telling him to tick something is no help when nothing was found at all: say what happened.
      if (st.candidates.length === 0) {
        const notes = attentionLines(savedNotes(st));
        return text([
          `No candidates were found for this ${periodWord}, so there is nothing to build.`,
          ...(notes.length ? ["Sources that need attention:", ...notes] : []),
          `Nothing is sent, and nothing is invented. Prepare again with prepare_month force once the sources are working, or add an event with add_event.`,
        ].join("\n"), true);
      }
      return text("Nothing is ticked. Tick at least one item with set_selection, then build again.", true);
    }
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
        // It used to answer every unknown key with "a newer one was built" — a confident, specific
        // diagnosis that is simply false when the key was mistyped or came from a previous run, and
        // it sent Bader off to rebuild a draft that was fine. Only one draft is ever kept, so why
        // his key does not match cannot be known; what can be said is what is actually there.
        case "missing": {
          const draft = currentDraft(st);
          return text(draft
            ? `That key does not match the draft I have. This ${periodWord}'s draft is ${draft.key} — approve that one, or build again if anything has changed since.`
            : `Nothing has been built for this ${periodWord} yet, so there is no draft to approve. Build one with build_draft first.`, true);
        }
        case "saved": return text(`Approved and saved to ${r.files.html}. No email platform is configured, so nothing was created there.`);
        // Never only the platform's own sentence. Whatever went wrong, Bader is told that his work
        // is safe, that nothing went out, and what to do next — otherwise he is left holding a
        // developer's error message with no idea whether the newsletter survived.
        case "failed": return text([
          `${r.platform} would not take the newsletter just now, so nothing was created there and nothing was sent.`,
          `Your draft is safe: it is still here, and it is saved at ${r.files.html}.`,
          "Try approving again in a minute. If it keeps failing, send the maintainer this line:",
          `  ${r.error.message}`,
        ].join("\n"), true);
        case "already": return text(`Already approved. Campaign ${r.campaign.id} in ${r.campaign.platform}: ${r.campaign.editUrl}`);
        case "updated": return text([
          `Approved. This month's campaign ${r.campaign.id} in ${r.campaign.platform} was updated with the new version (still not sent)${r.campaign.editUrl ? `: ${r.campaign.editUrl}` : "."}`,
          "Any changes Bader made directly in Mailchimp have been replaced by this version.",
          `To send: send_campaign with campaign_id ${r.campaign.id} and confirm: true, once Bader says so.`,
        ].join("\n"));
        // Reached now when Mailchimp says so, not only when this side remembered it — including a
        // send made from Mailchimp's own editor, which this side had no way of knowing about.
        case "period-sent": return text([
          `This ${periodWord}'s newsletter has already gone out (campaign ${r.campaignId}), so it cannot be changed: subscribers have it.`,
          `This version was saved to ${r.files.html} and applied nowhere.`,
        ].join("\n"), true);
        case "created": return text([
          `Approved. Campaign ${r.campaign.id} created in ${r.campaign.platform} (not sent): ${r.campaign.editUrl}`,
          `Audience: ${r.audience.audienceName} (${r.audience.memberCount} contacts).`,
          ...(r.held.length ? [`It includes ${r.held.length} item(s) the source put on hold: ${r.held.map((h) => h.title).join("; ")}. Check before sending.`] : []),
          `To send: send_campaign with campaign_id ${r.campaign.id} and confirm: true, once Bader says so.`,
        ].join("\n"));
      }
    } catch (e) {
      if (e instanceof DryRunRefusal) return text(`This is a practice run, so no email was created. The draft is saved at ${resolve(d.outDir)}. Ask the maintainer to switch the newsletter to live when you are ready to send for real.`);
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
      if (e instanceof DryRunRefusal) return text("This is a practice run, so nothing was sent. Ask the maintainer to switch the newsletter to live when you are ready to send for real.");
      throw e;
    }
  });

  // ---- Sources Bader manages himself (src/sources/curator-sources.ts holds the merge) ----

  /**
   * Read a source once, so Bader learns now whether it answers rather than a month later. What it
   * returns is never stored, and the words are the same ones the other surfaces use for a failure.
   */
  async function checkSource(source: SourceConfig, about: { name: string; kind: string; keeps: string; keepsWords: string; link?: string }): Promise<{ ok: boolean; text: string; allDropped?: boolean }> {
    const fetcher = fetcherFor(source.kind);
    if (!fetcher) return { ok: false, text: `There is no reader for ${source.kind} yet, so it cannot be checked.` };
    const say = (note: SourceNote) => explainSourceNote(note, { ...about, periodWord });
    try {
      const r = await fetcher.fetch(source, {
        config: d.config, clock: d.clock, storage: d.storage, windows: windowsFor(d.clock.now(), d.config), env: d.env,
        ...(d.fetchText ? { fetchText: d.fetchText } : {}),
      });
      if (r.error) return { ok: false, text: say({ id: source.id, status: "failed", error: r.error, warnings: r.warnings }) };
      // The run filters a calendar, a LinkedIn page and a Slack channel after fetching them, so a
      // raw count here would promise items the month will throw away.
      const relevant = keepRelevant(source, d.config, r.items);
      const warnings = relevant.dropped ? [...r.warnings, `${relevant.dropped} item(s) dropped as off-topic`] : r.warnings;
      // "Nothing in the window" and "everything was filtered out" are different facts to him.
      if (relevant.items.length === 0) {
        const note: SourceNote = { id: source.id, status: "empty", warnings };
        return { ok: true, text: say(note), allDropped: droppedCount(warnings) > 0 };
      }
      return { ok: true, text: `Read it: ${relevant.items.length} item(s) it would keep this ${periodWord}, for example "${relevant.items[0]!.title}".` };
    } catch (e) {
      return { ok: false, text: say({ id: source.id, status: "failed", error: (e as Error).message }) };
    }
  }

  server.registerTool("list_sources", {
    title: "List the sources",
    description: `Everything read for the newsletter each ${periodWord}: what it reads, whether it is on, how it filters, and who set it up.`,
    annotations: { readOnlyHint: true },
  }, async () => {
    const st = await current();
    const all = describeSources(d.config, d.storage);
    const mine = new Map(d.storage.listCuratorSources().map((r) => [r.id, r]));
    const notes = new Map<string, string>((st.reminder?.input.sourceNotes ?? []).map((n: string) => [n.slice(0, n.indexOf(":")), n.slice(n.indexOf(":") + 2)]));
    const links = linksBySource();
    const lineFor = (s: SourceConfig) => sourceLine({
      source: s, config: d.config,
      ...(mine.get(s.id) ? { mine: mine.get(s.id)! } : {}),
      ...(notes.get(s.id) || mine.get(s.id)?.last_note ? { lastRun: notes.get(s.id) || mine.get(s.id)!.last_note } : {}),
      ...(links[s.id] ? { link: links[s.id]! } : {}),
      timeZone: tz,
    });
    const lines = all.sources.map(lineFor);
    // One he turned off is still his, so it is listed rather than quietly disappearing.
    for (const r of mine.values()) {
      if (!all.sources.some((s) => s.id === r.id) && !all.broken.some((b) => b.id === r.id)) {
        const off = sourceLink({ kind: r.kind, url: r.url, channel_id: r.channel_id, fallback_link: r.fallback_link } as unknown as SourceConfig);
        lines.push(sourceLine({ source: { id: r.id, kind: r.kind, enabled: r.enabled } as unknown as SourceConfig, mine: r, config: d.config, timeZone: tz, ...(off ? { link: off } : {}) }));
      }
    }
    return text([
      `${lines.length} source(s) for this ${periodWord}:`,
      ...lines,
      ...(all.broken.length ? ["", "These cannot be read as they are, and are skipped:", ...all.broken.map((b) => `- ${b.id}: ${b.errors.join("; ")}`)] : []),
      ...(all.shadowed.length ? ["", `Already set up by the maintainer, so yours is ignored: ${all.shadowed.join(", ")}`] : []),
    ].join("\n"));
  });

  server.registerTool("add_source", {
    title: "Add a source",
    description: "Add somewhere the newsletter reads items from. Use only what Bader gives you: an address, search words, or a Slack channel link. Never invent a source, and never add one he did not name.",
    inputSchema: {
      kind: z.enum(ADDABLE_KINDS).describe("What he is adding: rss for a feed, google_news for a news search, ics for a calendar, linkedin_company for a company page, slack_channel for a Slack channel."),
      url: z.string().optional().describe("The full https:// address of the feed, calendar or page. Leave it out for a news search."),
      terms: z.array(z.string()).optional().describe("For a news search only: the words to search for, in Bader's own words, such as Volta Halifax."),
      channel_id: z.string().optional().describe("For a Slack channel: the link from Copy link, or the id such as C0123ABCD from the channel's About tab."),
      keywords: z.array(z.string()).optional().describe("Keep only items from this source mentioning one of these words. Leave it out to use the newsletter's watchlist, or give an empty list to keep everything it publishes."),
      name: z.string().optional().describe("A short name for the source list, in Bader's words. It is never printed in the newsletter."),
      content: z.enum(["news", "events"]).optional().describe("Whether a feed lists news or events. A calendar is events already."),
      check: z.boolean().optional().describe("Read the source once now to see whether it answers. True unless Bader says not to."),
      refresh: z.boolean().optional().describe("Fetch every source again straight away, so this one's items appear in the list now."),
    },
  }, async (f) => {
    const taken = describeSources(d.config, d.storage).sources.map((s) => s.id);
    const made = sourceFromFields({
      kind: f.kind,
      ...(f.url ? { url: f.url } : {}), ...(f.terms ? { terms: f.terms } : {}), ...(f.channel_id ? { channel_id: f.channel_id } : {}),
      ...(f.keywords ? { keywords: f.keywords } : {}), ...(f.name ? { name: f.name } : {}), ...(f.content ? { content: f.content } : {}),
    }, taken);
    if ("errors" in made) return text(`Not added:\n${made.errors.map((e) => `- ${e}`).join("\n")}`, true);

    const asSource = toSourceConfig({ ...made.row, last_note: "", added_at: d.clock.now().toISOString() });
    if ("errors" in asSource) return text(`Not added:\n${asSource.errors.map((e) => `- ${e}`).join("\n")}`, true);

    // A Slack channel with no token is kept but left off, so it can never look as if it were working.
    const blocked = made.row.kind === "slack_channel" && !d.env.SLACK_BOT_TOKEN;
    const row = d.storage.addCuratorSource({ ...made.row, enabled: !blocked, added_at: d.clock.now().toISOString() });
    const note = credentialNote(row.kind, d.env);

    const keeps = filterWords(row, d.config, row.kind);
    const lines = [`Added ${KIND_LABEL[f.kind]}: ${row.label || row.id} reads ${readsWhat(row)}, and keeps ${keeps}.`];
    if (note) lines.push(note);
    // Whether it can be read at all decides the last line: promising it will be read while it sits
    // switched off, or right after the check failed, is the kind of thing that costs trust.
    const link = sourceLink(asSource.source);
    const checked = f.check !== false && !blocked
      ? await checkSource(asSource.source, { name: row.label || row.id, kind: row.kind, keeps, keepsWords: filterTerms(row, d.config, row.kind), ...(link ? { link } : {}) })
      : undefined;
    if (checked) {
      lines.push(checked.text);
      // Kept, so the list says how it did instead of showing a broken source as plain "on".
      d.storage.setCuratorSourceNote(row.id, checked.ok ? "" : checked.text.replace(/^[^:]*(could not be read|was not read)/, "$1"));
    }
    if (blocked) {
      lines.push("I have added it but left it switched off, so nothing looks broken while it waits. Once that is done, say: turn it back on.");
    } else if (checked?.allDropped) {
      lines.push(`Fetching again now would drop them again. Say: keep everything from ${row.label || row.id}, then: refresh this ${periodWord}.`);
    } else if (checked && !checked.ok) {
      lines.push("I have kept it, in case the address is right and the trouble is temporary. Say: turn it off, if you would rather it stopped being tried.");
    } else if (f.refresh) {
      const st = await current();
      const run = await prepareNow(st);
      const got = run.sources.find((s) => s.id === row.id);
      lines.push(`Fetched everything again: ${run.candidates.length} candidates, and this source ${got ? `${got.status}${got.items ? ` with ${got.items} item(s)` : ""}` : "was not read"}.`);
    } else {
      lines.push(`It will be read when this ${periodWord} is next prepared. To see its items now, say: refresh this ${periodWord}.`);
    }
    lines.push(`Its id is ${row.id}.`);
    return text(lines.join("\n"));
  });

  server.registerTool("set_source", {
    title: "Turn a source on or off, or change its keywords",
    description: "Stop or start reading one of Bader's own sources, or replace the words it keeps items by. The maintainer's sources cannot be changed here.",
    inputSchema: {
      source_id: z.string().describe("The source's id, as list_sources shows it."),
      enabled: z.boolean().optional().describe("False stops reading it without losing it; true starts again."),
      keywords: z.array(z.string()).optional().describe("Replace the words it keeps items by. An empty list keeps everything it publishes."),
    },
  }, async ({ source_id, enabled, keywords }) => {
    const mine = d.storage.listCuratorSources().find((r) => r.id === source_id);
    if (!mine) return text(notHis(source_id, "change"), true);
    if (enabled === undefined && keywords === undefined) return text("Nothing to change: give enabled, keywords, or both.", true);
    if (keywords !== undefined) {
      // The row is replaced rather than patched, so its id, and every edit keyed by it, stay as they are.
      d.storage.removeCuratorSource(mine.id);
      d.storage.addCuratorSource({ ...mine, keywords, filtered: true, ...(enabled === undefined ? {} : { enabled }) });
    } else if (enabled !== undefined) {
      d.storage.setCuratorSourceEnabled(mine.id, enabled, d.clock.now().toISOString());
    }
    const now = d.storage.listCuratorSources().find((r) => r.id === source_id)!;
    const note = now.enabled ? credentialNote(now.kind, d.env) : undefined;
    return text([
      `${now.label || now.id} is now ${now.enabled ? "on" : "off"}, and keeps ${filterWords(now, d.config, now.kind)}.`,
      ...(note ? [note] : []),
      `It takes effect when this ${periodWord} is next prepared.`,
    ].join("\n"));
  });

  server.registerTool("remove_source", {
    title: "Remove a source",
    description: "Forget one of Bader's own sources. Items already fetched from it stay in this period's list, and anything already sent is untouched. Ask him first.",
    inputSchema: {
      source_id: z.string().describe("The source's id, as list_sources shows it."),
      confirm: z.boolean().describe("true only when Bader has said to remove it."),
    },
    annotations: { destructiveHint: true },
  }, async ({ source_id, confirm }) => {
    if (!confirm) return text("Not removed: confirm must be true, and only once Bader has said to remove it.", true);
    const mine = d.storage.listCuratorSources().find((r) => r.id === source_id);
    if (!mine) return text(notHis(source_id, "remove"), true);
    d.storage.removeCuratorSource(source_id);
    return text([
      `Removed ${mine.label || mine.id}. It will not be read again.`,
      `Items already fetched from it stay in this ${periodWord}'s list until it is prepared again, and anything already sent is untouched.`,
    ].join("\n"));
  });

  /** Why a source id cannot be changed here: it is the maintainer's, or there is no such source. */
  function notHis(id: string, verb: string): string {
    const theirs = d.config.sources.find((s) => s.id === id);
    if (theirs) return `${id} is set up by the maintainer in the config file; ask them to ${verb} it.`;
    return `There is no source called ${id}. Use list_sources to see them.`;
  }

  return server;
}

/** One candidate as a line Claude can read back: id, tick, title, when and where, and what was edited. */
export function describeItem(it: Item, ticked: boolean, timeZone: string, now?: Date): string {
  const p = partsInZone(new Date(it.date), timeZone);
  const date = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
  const time = `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
  // A held item leads with the same label the Slack list used, so it is seen before it is ticked.
  const bits = [
    `${ticked ? "[x]" : "[ ]"} ${it.requires_review ? `${REVIEW_LABEL} · ` : ""}${it.title}`,
    it.type === "event" ? `${isPastEvent(it, now) ? "held" : "on"} ${date} ${time}${it.location ? ` at ${it.location}` : ""}` : `${it.type} from ${it.source}, ${date}`,
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
  /**
   * The one group asked for, when the list was narrowed to it. The counts above always cover the
   * whole period, so the panel has to be able to say that what it is drawing is a part of it.
   */
  showing?: "upcoming" | "past" | "other";
  groups: Array<{ key: "upcoming" | "past" | "other"; title: string; items: PanelItem[] }>;
};

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS: Record<string, string> = { sunday: "Sun", monday: "Mon", tuesday: "Tue", wednesday: "Wed", thursday: "Thu", friday: "Fri", saturday: "Sat" };

export function panelItem(it: Item, ticked: boolean, timeZone: string, now?: Date): PanelItem {
  const p = partsInZone(new Date(it.date), timeZone);
  const pad = (n: number) => String(n).padStart(2, "0");
  const dateLocal = `${p.year}-${pad(p.month)}-${pad(p.day)}`;
  const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  const isEvent = it.type === "event";
  const when = isEvent
    ? `${isPastEvent(it, now) ? "held " : ""}${DAYS[p.weekday] ?? ""} ${MONTHS[p.month - 1]!.slice(0, 3)} ${p.day}, ${h12}:${pad(p.minute)} ${p.hour < 12 ? "am" : "pm"}`
    : dateLocal;
  const hasPoints = Boolean(it.insights?.length);
  const prints = hasPoints ? it.insights! : it.summary ? [it.summary] : [];
  // The summary is only worth adding when it says something the points do not.
  const alreadySaid = hasPoints && it.summary ? prints.join(" ").includes(it.summary.trim()) : false;
  const notes = [...(hasPoints && it.summary && !alreadySaid ? [it.summary] : []), ...(it.editor_notes ?? [])];
  return {
    id: it.id, title: it.title, ticked, isEvent, when, dateLocal, timeLocal: `${pad(p.hour)}:${pad(p.minute)}`,
    ...(it.location ? { location: it.location } : {}), held: it.requires_review, ...(it.hold_note ? { holdNote: it.hold_note } : {}),
    prints, hasPoints, notes, edited: it.edited_fields ?? [], manual: isManualItem(it), ...(it.image ? { image: it.image } : {}), link: it.link,
  };
}

/** Everything the review panel draws: the period, the mode and the three groups. */
export function panelState(st: ReviewState, periodWord: string, timeZone: string, live: boolean, group?: string): PanelState {
  const now = st.now?.();
  const g = candidateGroups(st);
  const ticked = new Set(currentSelection(st));
  const items = (list: RankedItem[]) => list.map((c) => panelItem(c.item, ticked.has(c.item.id), timeZone, now));
  const key = st.week ?? "";
  const monthly = /^\d{4}-\d{2}$/.test(key);
  const periodLabel = monthly ? `${MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}` : `Week of ${key}`;
  const groups: PanelState["groups"] = [
    { key: "upcoming", title: "Upcoming events", items: items(g.upcomingEvents) },
    { key: "past", title: periodWord === "month" ? "Last month's events" : "Past events", items: items(g.pastEvents) },
    { key: "other", title: "News and updates", items: items(g.other) },
  ];
  // Asking for one group must narrow both what is read out and what the panel shows, or "just
  // the upcoming events" answers with all forty-four of them. It is named as well as applied: a
  // panel that is drawing part of the month and says nothing about it is a panel Bader reads as
  // the whole of it.
  const only = group && group !== "all" ? groups.find((x) => x.key === group) : undefined;
  return {
    periodLabel, dryRun: !live, ticked: ticked.size, total: st.candidates.length,
    ...(only ? { showing: only.key } : {}),
    groups: only ? [only] : groups,
  };
}
