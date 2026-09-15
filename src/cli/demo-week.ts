/**
 * Run the full weekly cycle in dry-run mode against the live sources.
 * Usage: npm run demo:week [-- --now=2026-10-13T08:30:00-03:00]
 * Writes out/candidates.json, out/drafts/*.md|html, out/alerts.log, out/run.json. Sends nothing.
 */
import { loadDotEnv } from "./env.js";
import { ConsoleFileAlerter } from "../alerts.js";
import { resolveClock } from "../clock.js";
import { loadConfig } from "../config.js";
import { runWeek } from "../run-week.js";
import { SqliteStorage } from "../storage.js";

loadDotEnv();
const config = await loadConfig(process.env.CONFIG_PATH ?? "demo/config.json");
const clock = resolveClock();
const outDir = process.env.OUT_DIR ?? "out";
const storage = new SqliteStorage(process.env.DATABASE_PATH ?? `${outDir}/newsletter.sqlite`);
const alerter = new ConsoleFileAlerter(`${outDir}/alerts.log`, () => clock.now());

console.log(`demo:week  clock=${clock.label}  now=${clock.now().toISOString()}  dry-run=${process.env.ALLOW_LIVE === "1" ? "NO (ALLOW_LIVE=1)" : "yes"}`);
console.log("");
const s = await runWeek({ config, clock, storage, alerter, outDir });
storage.close();

console.log("");
for (const src of s.sources) console.log(`${src.status.toUpperCase().padEnd(8)} ${src.id.padEnd(16)} items=${src.items}${src.error ? `  ${src.error}` : ""}`);
console.log(`\nfetched=${s.fetched}  after dedupe=${s.after_dedupe}  merges=${s.merges.length}  candidates=${s.candidates.length}  preselected=${s.preselected_ids.length}`);
for (const m of s.merges) console.log(`  merge: ${m}`);
console.log("\ndrafts:");
for (const d of s.drafts) console.log(`  ${d.id.padEnd(13)} ${d.verified ? "verified" : "REJECTED " + d.violations.join("; ")}  ${d.verified ? d.file_html : ""}`);
console.log(`\nfirst workday: ${s.first_workday.weekday} ${s.first_workday.date}${s.first_workday.skipped.length ? `  (skipped: ${s.first_workday.skipped.join("; ")})` : ""}`);
console.log(`local now:     ${s.local_now}  reminder ${config.reminder_time}  due now: ${s.reminder_due ? "YES" : "no"}`);
console.log(`alerts:        ${s.alerts}  (${outDir}/alerts.log)`);
console.log(`summary:       ${outDir}/run.json`);
if (s.sources.some((x) => x.status === "failed") || s.drafts.every((d) => !d.verified)) process.exitCode = 1;
