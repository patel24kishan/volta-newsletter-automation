/**
 * Slack-connected demo. Runs the weekly cycle, then DMs the reminder to SLACK_BADER_USER_ID and
 * stays connected (Socket Mode) to handle selection, Generate drafts, and Approve. Ctrl+C to stop.
 *
 * Usage: ALLOW_LIVE=1 npm run demo:slack [-- --now=2026-10-13T08:30:00-03:00] [--send-now]
 *   --send-now   send the reminder even if it is not the first workday / reminder time yet
 * Without ALLOW_LIVE=1 this refuses to send (dry-run default).
 */
import { loadDotEnv } from "./env.js";
import { ConsoleFileAlerter } from "../alerts.js";
import { resolveClock } from "../clock.js";
import { loadConfig } from "../config.js";
import { mailchimpFromEnv } from "../publish/mailchimp.js";
import { runWeek } from "../run-week.js";
import { SqliteStorage } from "../storage.js";
import { sendReminder, type SurfaceState } from "../surface/handlers.js";
import { createSlackApp } from "../surface/slack.js";

loadDotEnv();
const argv = process.argv.slice(2);
const config = await loadConfig(process.env.CONFIG_PATH ?? "demo/config.json");
const clock = resolveClock(argv);
const outDir = process.env.OUT_DIR ?? "out";
const storage = new SqliteStorage(process.env.DATABASE_PATH ?? `${outDir}/newsletter.sqlite`);
const alerter = new ConsoleFileAlerter(`${outDir}/alerts.log`, () => clock.now());
const userId = process.env.SLACK_BADER_USER_ID;
if (!userId) throw new Error("SLACK_BADER_USER_ID must be set in .env (your Slack member ID)");

console.log(`demo:slack  clock=${clock.label}  live=${process.env.ALLOW_LIVE === "1" ? "yes" : "NO (set ALLOW_LIVE=1 to send)"}`);
const run = await runWeek({ config, clock, storage, alerter, outDir });
console.log(`fetched=${run.fetched} candidates=${run.candidates.length} drafts verified=${run.drafts.filter((d) => d.verified).length}/${run.drafts.length}`);

// Storage stays open: the Add an event form writes to it long after the weekly run finished.
for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => { storage.close(); process.exit(0); });

const st: SurfaceState = { candidates: run.candidates, timeZone: config.timezone, outDir, drafts: new Map(), selections: new Map(), env: process.env, campaigns: new Set(), now: () => clock.now() };

const manual = config.sources.find((s) => s.kind === "manual" && s.enabled);
if (manual?.fallback_link) {
  st.storage = storage;
  st.manualSource = { ...manual, fallback_link: manual.fallback_link };
} else {
  console.log('events: no enabled "manual" source in config, so the Add an event button will not work');
}

const publisher = mailchimpFromEnv(process.env);
if (publisher) {
  // Fail loud before anyone presses Approve: bad key or audience id stops the demo here.
  st.audience = await publisher.verify();
  st.publisher = publisher;
  console.log(`email: ${publisher.platform} connected, audience "${st.audience.audienceName}" (${st.audience.memberCount} contacts)`);
} else {
  console.log("email: not configured (MAILCHIMP_API_KEY / MAILCHIMP_LIST_ID unset); Approve stops at out/final.html");
}
const { app, client } = createSlackApp(process.env, st, alerter);
await app.start();
console.log("connected to Slack (Socket Mode)");

const sendNow = argv.includes("--send-now");
if (run.reminder_due || sendNow) {
  const sourceNotes = run.sources.filter((s) => s.status !== "ok").map((s) => `${s.id}: ${s.status}${s.error ? ` (${s.error})` : ""}`);
  const r = await sendReminder(client, userId, { candidates: run.candidates, preselectedIds: run.preselected_ids, firstWorkday: run.first_workday, timeZone: config.timezone, clockLabel: clock.label, sourceNotes }, st);
  console.log(`reminder sent to ${userId} in ${r.channel} (ts ${r.ts}). Waiting for actions; Ctrl+C to stop.`);
} else {
  console.log(`reminder not due (first workday ${run.first_workday.weekday} ${run.first_workday.date}, reminder ${config.reminder_time}; local now ${run.local_now}). Pass --send-now to send anyway. Waiting for actions; Ctrl+C to stop.`);
}
