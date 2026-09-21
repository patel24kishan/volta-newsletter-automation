/**
 * Slack-connected demo. Runs the weekly cycle, then DMs the reminder to SLACK_BADER_USER_ID and
 * stays connected (Socket Mode) to handle selection, Generate drafts, and Approve. Ctrl+C to stop.
 *
 * Usage: ALLOW_LIVE=1 npm run demo:slack [-- --now=2026-10-13T08:30:00-03:00] [--send-now]
 *   --send-now   start a fresh review now: run the week and send a new reminder, even if one was
 *                already sent this week or it is not yet the first workday / reminder time
 * Without --send-now, a review already under way this week is picked up where it was left, so a
 * restart does not lose a draft or a campaign waiting to be sent.
 * Without ALLOW_LIVE=1 this refuses to send (dry-run default).
 */
import { loadDotEnv } from "./env.js";
import { ConsoleFileAlerter } from "../alerts.js";
import { resolveClock } from "../clock.js";
import { loadConfig } from "../config.js";
import { mailchimpFromEnv } from "../publish/mailchimp.js";
import { runWeek, type RunSummary } from "../run-week.js";
import { mondayOfWeek } from "../schedule/first-workday.js";
import { SqliteStorage } from "../storage.js";
import { sendReminder, type SurfaceState } from "../surface/handlers.js";
import { startPreviewServer } from "../surface/preview-server.js";
import { loadCampaigns, loadReview, restoreSession, type SessionSnapshot } from "../surface/session.js";
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
const sendNow = argv.includes("--send-now");
const week = mondayOfWeek(clock.now(), config.timezone);

console.log(`demo:slack  clock=${clock.label}  live=${process.env.ALLOW_LIVE === "1" ? "yes" : "NO (set ALLOW_LIVE=1 to send)"}`);

// A review already under way this week is picked up, unless --send-now asks for a fresh one.
// Bad saved state is set aside with an alert rather than crashing: a hosted process that died on
// every start would never recover without a human.
let restored: SessionSnapshot | undefined;
if (!sendNow) {
  const loaded = loadReview(storage, week);
  if (loaded && "error" in loaded) alerter.alert("error", "session", `could not pick up this week's review: ${loaded.error}`, "starting a fresh review; generate the draft again");
  else if (loaded) restored = loaded.snapshot;
}

let run: RunSummary | undefined;
if (restored) {
  // Not re-fetched: the list stays exactly what Bader was shown, and a redeploy neither re-fires
  // every alert nor asks LinkedIn a second time in the same week.
  console.log(`session: picked up this week's review (reminder sent ${restored.reminder.sentAt}); sources not fetched again`);
} else {
  run = await runWeek({ config, clock, storage, alerter, outDir });
  console.log(`fetched=${run.fetched} candidates=${run.candidates.length} drafts verified=${run.drafts.filter((d) => d.verified).length}/${run.drafts.length}`);
}

// Storage stays open: the Add an event form and the review itself write to it all week.
for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => { storage.close(); process.exit(0); });

const st: SurfaceState = {
  candidates: run?.candidates ?? [], timeZone: config.timezone, outDir, drafts: new Map(), selections: new Map(),
  env: process.env, campaigns: new Set(), now: () => clock.now(), layout: config.draft_layout, session: storage, week,
};

// Campaigns are kept across weeks, so one approved before a restart can still be sent after it.
loadCampaigns(st, storage);
if (st.campaigns.size) console.log(`email: ${st.campaigns.size} approved campaign(s) not yet sent`);

// Serves the rendered email so Slack can link to the real thing, not Slack's approximation of it.
try {
  const preview = await startPreviewServer();
  st.preview = preview;
  console.log(`preview: serving the rendered newsletter at ${preview.baseUrl}${process.env.PUBLIC_URL ? "" : " (this machine only)"}`);
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => { void preview.close(); });
} catch (e) {
  console.log(`preview: not available (${(e as Error).message}); Slack will show the draft without a preview button`);
}

// After the preview server, so the draft's page is served again at the address Bader already has.
if (restored) restoreSession(st, restored);

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

if (restored) {
  console.log(`reminder already sent this week, not sent again. ${st.drafts.size ? "The draft is still waiting for Approve." : "No draft generated yet."} Pass --send-now to start a fresh review. Waiting for actions; Ctrl+C to stop.`);
} else if (run!.reminder_due || sendNow) {
  const sourceNotes = run!.sources.filter((s) => s.status !== "ok").map((s) => `${s.id}: ${s.status}${s.error ? ` (${s.error})` : ""}`);
  const r = await sendReminder(client, userId, { candidates: run!.candidates, preselectedIds: run!.preselected_ids, firstWorkday: run!.first_workday, timeZone: config.timezone, clockLabel: clock.label, sourceNotes }, st);
  console.log(`reminder sent to ${userId} in ${r.channel} (ts ${r.ts}). Waiting for actions; Ctrl+C to stop.`);
} else {
  console.log(`reminder not due (first workday ${run!.first_workday.weekday} ${run!.first_workday.date}, reminder ${config.reminder_time}; local now ${run!.local_now}). Pass --send-now to send anyway. Waiting for actions; Ctrl+C to stop.`);
}
