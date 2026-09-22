/**
 * Slack-connected demo. Runs the weekly cycle, then DMs the reminder to SLACK_BADER_USER_ID and
 * stays connected (Socket Mode) to handle selection, Generate drafts, and Approve. Ctrl+C to stop.
 * The unattended version, which sends the reminder on schedule by itself, is `npm run serve`.
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
import { runWeek, type RunSummary } from "../run-week.js";
import { mondayOfWeek } from "../schedule/first-workday.js";
import { SqliteStorage } from "../storage.js";
import { sendReminder } from "../surface/handlers.js";
import { serialQueue } from "../surface/serial.js";
import { pickUpReview, reminderInputFrom, startSurface } from "./start-surface.js";

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
// Bad saved state is set aside with an alert rather than crashing.
const picked = sendNow ? { week } : pickUpReview(storage, week, { fallBackAWeek: false });
if (picked.error) alerter.alert("error", "session", `could not pick up this week's review: ${picked.error}`, "starting a fresh review; generate the draft again");
const restored = picked.snapshot;

let run: RunSummary | undefined;
if (restored) {
  // Not re-fetched: the list stays exactly what Bader was shown, and a redeploy neither re-fires
  // every alert nor asks LinkedIn a second time in the same week.
  console.log(`session: picked up this week's review (reminder sent ${restored.reminder.sentAt}); sources not fetched again`);
} else {
  run = await runWeek({ config, clock, storage, alerter, outDir });
  console.log(`fetched=${run.fetched} candidates=${run.candidates.length} drafts verified=${run.drafts.filter((d) => d.verified).length}/${run.drafts.length}`);
}

const surface = await startSurface({
  config, clock, env: process.env, storage, alerter, outDir, candidates: run?.candidates ?? [], week,
  ...(restored ? { restored } : {}), tolerateEmailOutage: false, queue: serialQueue(),
});

// One handler: stop taking clicks, close the preview, and close storage last.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.once(sig, () => {
    void surface.stopSlack().catch(() => undefined)
      .then(() => surface.closePreview())
      .finally(() => { storage.close(); process.exit(0); });
  });
}

if (restored) {
  console.log(`reminder already sent this week, not sent again. ${surface.st.drafts.size ? "The draft is still waiting for Approve." : "No draft generated yet."} Pass --send-now to start a fresh review. Waiting for actions; Ctrl+C to stop.`);
} else if (run!.reminder_due || sendNow) {
  const r = await sendReminder(surface.client, userId, reminderInputFrom(run!, config, clock.label), surface.st);
  console.log(`reminder sent to ${userId} in ${r.channel} (ts ${r.ts}). Waiting for actions; Ctrl+C to stop.`);
} else {
  console.log(`reminder not due (first workday ${run!.first_workday.weekday} ${run!.first_workday.date}, reminder ${config.reminder_time}; local now ${run!.local_now}). Pass --send-now to send anyway, or run \`npm run serve\` to send it on schedule. Waiting for actions; Ctrl+C to stop.`);
}
