/**
 * The weekly cycle, end to end, with no side effects outside `outDir`:
 * fetch every enabled source -> store -> dedupe -> summarize -> rank -> pre-select -> drafts ->
 * verify -> write candidates, drafts and a run summary -> compute the first workday and whether
 * the reminder is due. Alerts fire for every failure, empty source, and unverifiable draft.
 * Delivery (Slack, email) is a separate step that reads this run's output (D9).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Alerter } from "./alerts.js";
import type { Clock } from "./clock.js";
import type { Config } from "./config.js";
import { buildDrafts, type Draft } from "./draft/templates.js";
import { fetcherFor } from "./fetchers/index.js";
import type { FetchContext } from "./fetchers/types.js";
import { dedupeItems } from "./pipeline/dedupe.js";
import { rankItems, type RankedItem } from "./pipeline/rank.js";
import { ExtractiveSummarizer } from "./pipeline/summarize.js";
import type { Item } from "./schema.js";
import { firstWorkdayOfWeek, reminderDue, type FirstWorkday } from "./schedule/first-workday.js";
import type { Storage } from "./storage.js";

export interface RunOptions {
  config: Config;
  clock: Clock;
  storage: Storage;
  alerter: Alerter;
  outDir: string;
  /** Test hook: replaces the network for every fetcher. */
  fetchText?: FetchContext["fetchText"];
  /** Test hook: replaces the Slack Web API for the channel fetcher. */
  slackApi?: FetchContext["slackApi"];
  /** Where fetcher credentials come from; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** How many top-ranked items seed the pre-generated drafts. */
  preselect?: number;
}

export interface RunSummary {
  ran_at: string;
  clock: string;
  sources: Array<{ id: string; status: "ok" | "empty" | "failed" | "skipped"; items: number; error?: string; warnings: string[] }>;
  fetched: number;
  after_dedupe: number;
  merges: string[];
  candidates: RankedItem[];
  preselected_ids: string[];
  drafts: Array<{ id: Draft["id"]; name: string; subject: string; verified: boolean; violations: string[]; file_md: string; file_html: string }>;
  first_workday: FirstWorkday;
  reminder_due: boolean;
  local_now: string;
  alerts: number;
}

export async function runWeek(o: RunOptions): Promise<RunSummary> {
  const { config, clock, storage, alerter } = o;
  const now = clock.now();
  mkdirSync(join(o.outDir, "drafts"), { recursive: true });

  // 1. Fetch (in parallel; each source reports independently)
  const enabled = config.sources.filter((s) => s.enabled);
  const results = await Promise.all(
    enabled.map(async (s) => {
      const f = fetcherFor(s.kind);
      if (!f) return { s, r: undefined };
      const ctx: FetchContext = {
        config, clock, storage,
        ...(o.fetchText ? { fetchText: o.fetchText } : {}),
        ...(o.slackApi ? { slackApi: o.slackApi } : {}),
        ...(o.env ? { env: o.env } : {}),
      };
      return { s, r: await f.fetch(s, ctx) };
    }),
  );

  const sources: RunSummary["sources"] = [];
  const fetched: Item[] = [];
  for (const { s, r } of results) {
    if (!r) {
      sources.push({ id: s.id, status: "skipped", items: 0, warnings: ["fetcher not built"] });
      alerter.alert("warning", s.id, `no fetcher for kind "${s.kind}"`, "build the fetcher or disable the source in config");
      continue;
    }
    if (r.error) {
      sources.push({ id: s.id, status: "failed", items: 0, error: r.error, warnings: r.warnings });
      alerter.alert("error", s.id, r.error, "check the source URL and network; the draft will say this source had no items");
      continue;
    }
    if (r.items.length === 0) {
      sources.push({ id: s.id, status: "empty", items: 0, warnings: r.warnings });
      alerter.alert("warning", s.id, "returned zero items in the window", "normal if quiet; verify the source manually if unexpected");
      continue;
    }
    sources.push({ id: s.id, status: "ok", items: r.items.length, warnings: r.warnings });
    fetched.push(...r.items);
  }

  // 2. Store, dedupe, summarize, rank
  storage.upsertItems(fetched);
  const { items: deduped, merges } = dedupeItems(fetched, config.timezone);
  const summarized = new ExtractiveSummarizer().summarize(deduped);
  const candidates = rankItems(summarized, now);

  // 3. Pre-select and draft (drafts are regenerated from Bader's own selection in D9)
  // An item flagged requires_review (a held or embargoed founder update) is always listed for
  // Bader, but is never pre-ticked and never written into a pre-generated draft, however quiet
  // the week. Only a person can put it in. Ranking alone would not guarantee that.
  const n = o.preselect ?? 10;
  const preselected = candidates.filter((c) => !c.item.requires_review).slice(0, n).map((c) => c.item);
  const drafts = buildDrafts(preselected, { timeZone: config.timezone, layouts: [config.draft_layout] });
  const draftRows: RunSummary["drafts"] = [];
  for (const d of drafts) {
    const md = join(o.outDir, "drafts", `${d.id}.md`);
    const html = join(o.outDir, "drafts", `${d.id}.html`);
    if (d.verification.ok) {
      writeFileSync(md, d.markdown, "utf8");
      writeFileSync(html, d.html, "utf8");
    } else {
      // Never show an unverifiable draft. Write it aside for the maintainer and alert.
      writeFileSync(join(o.outDir, "drafts", `${d.id}.REJECTED.md`), d.markdown, "utf8");
      alerter.alert("error", `draft:${d.id}`, `draft failed verification: ${d.verification.violations.map((v) => `${v.kind} "${v.value}"`).join(", ")}`, "inspect drafts/*.REJECTED.md; this draft is withheld from Bader");
    }
    draftRows.push({ id: d.id, name: d.name, subject: d.subject, verified: d.verification.ok, violations: d.verification.violations.map((v) => `${v.kind}: ${v.value}`), file_md: md, file_html: html });
  }
  if (draftRows.every((d) => !d.verified)) alerter.alert("error", "drafts", "no draft passed verification", "a human must write this week's newsletter by hand");

  // 4. Schedule
  const fw = firstWorkdayOfWeek(now, config);
  const due = reminderDue(now, config);
  if (fw.skipped.length) alerter.alert("info", "schedule", `first workday is ${fw.weekday} ${fw.date}; skipped: ${fw.skipped.join("; ")}`, "no action");

  const summary: RunSummary = {
    ran_at: new Date().toISOString(),
    clock: clock.label,
    sources,
    fetched: fetched.length,
    after_dedupe: deduped.length,
    merges,
    candidates,
    preselected_ids: preselected.map((i) => i.id),
    drafts: draftRows,
    first_workday: fw,
    reminder_due: due.due,
    local_now: due.localNow,
    alerts: alerter.sent.length,
  };
  writeFileSync(join(o.outDir, "candidates.json"), JSON.stringify(candidates, null, 2), "utf8");
  writeFileSync(join(o.outDir, "run.json"), JSON.stringify(summary, null, 2), "utf8");
  return summary;
}
