/**
 * The always-on service: what the container runs. It stays connected to Slack and checks every few
 * minutes whether the weekly reminder is due, sending it once, on the first workday, at the
 * reminder time in Halifax, with no one having to start anything.
 *
 * Usage:
 *   ALLOW_LIVE=1 npm run serve              the real service; needs DATABASE_PATH on a persistent volume
 *   npm run serve -- --now=<ISO>            a dry-run rehearsal: time starts at <ISO> and moves on from
 *                                            there, so the reminder moment can be watched arriving
 */
import { loadDotEnv } from "./env.js";
import { ConsoleFileAlerter } from "../alerts.js";
import { advancingClock, resolveClock } from "../clock.js";
import { loadConfig } from "../config.js";
import { runWeek } from "../run-week.js";
import { isLive } from "../runtime.js";
import { mondayOfWeek } from "../schedule/first-workday.js";
import { WeeklyScheduler } from "../schedule/scheduler.js";
import { SqliteStorage } from "../storage.js";
import { serialQueue } from "../surface/serial.js";
import { pickUpReview, reminderInputFrom, serveEnvironmentProblem, startSurface } from "./start-surface.js";

/** Worst case, the reminder arrives this long after its time. */
const CHECK_EVERY_MS = 5 * 60 * 1000;
/** Kept under the few seconds a host waits after SIGTERM before killing the process. */
const SHUTDOWN_WAIT_MS = 20_000;

loadDotEnv();
const env = process.env;
const argv = process.argv.slice(2);
const config = await loadConfig(env.CONFIG_PATH ?? "demo/config.json");

const requested = resolveClock(argv, env);
const problem = serveEnvironmentProblem(env, requested);
if (problem) {
  console.error(`serve: ${problem}`);
  process.exit(1);
}
// Only reachable in dry-run: a fixed instant would never reach the reminder, so it moves on from there.
const clock = requested.overridden ? advancingClock(requested.now()) : requested;

const outDir = env.OUT_DIR ?? "out";
const storage = new SqliteStorage(env.DATABASE_PATH ?? `${outDir}/newsletter.sqlite`);
const alerter = new ConsoleFileAlerter(`${outDir}/alerts.log`, () => clock.now());
const userId = env.SLACK_BADER_USER_ID;
if (!userId) throw new Error("SLACK_BADER_USER_ID must be set (the curator's Slack member ID)");

console.log(`serve  clock=${clock.label}  live=${isLive(env) ? "yes" : "NO (dry-run: rehearses the week once when due, sends nothing)"}`);

const picked = pickUpReview(storage, mondayOfWeek(clock.now(), config.timezone), { fallBackAWeek: true });
if (picked.error) alerter.alert("error", "session", `could not pick up this week's review: ${picked.error}`, "a replacement list is sent when the reminder is due");
if (picked.snapshot) console.log(`session: picked up the review for the week of ${picked.week} (reminder sent ${picked.snapshot.reminder.sentAt})`);

const queue = serialQueue();
const surface = await startSurface({
  config, clock, env, storage, alerter, outDir, candidates: [], week: picked.week,
  ...(picked.snapshot ? { restored: picked.snapshot } : {}), tolerateEmailOutage: true, queue,
});

const scheduler = new WeeklyScheduler({
  config, clock, storage, st: surface.st, client: surface.client, userId, alerter, queue,
  prepareWeek: async () => reminderInputFrom(await runWeek({ config, clock, storage, alerter, outDir }), config, clock.label),
  isLive: () => isLive(env),
  onNewReview: () => surface.refreshAudience(),
  everyTick: () => surface.retryEmail(),
});
scheduler.start(CHECK_EVERY_MS);
console.log(`serve: checking every ${CHECK_EVERY_MS / 60_000} minutes for the reminder (first workday, ${config.reminder_time} ${config.timezone}). Ctrl+C to stop.`);

// On a redeploy the host sends SIGTERM and waits only briefly, so this is quick and ordered: no
// new clicks, no new checks, let one already running finish, then close storage last.
let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.once(sig, () => {
    if (stopping) return;
    stopping = true;
    console.log(`serve: ${sig}, shutting down`);
    const giveUp = new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_WAIT_MS));
    void surface.stopSlack().catch(() => undefined)
      .then(() => Promise.race([scheduler.stop(), giveUp]))
      .then(() => surface.closePreview())
      .catch(() => undefined)
      .finally(() => { storage.close(); process.exit(0); });
  });
}
