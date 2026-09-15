/**
 * Pre-flight: hit every enabled live source and report. Exits 1 if any built fetcher failed or
 * returned zero items, so a cron can alert before newsletter day (constraint 8).
 * Usage: npm run check:sources [-- --now=2026-10-13T08:30:00-03:00]
 */
import { loadDotEnv } from "./env.js";
import { loadConfig } from "../config.js";
import { resolveClock } from "../clock.js";
import { fetcherFor } from "../fetchers/index.js";

loadDotEnv();
const config = await loadConfig(process.env.CONFIG_PATH ?? "demo/config.json");
const clock = resolveClock();

console.log(`check:sources  clock=${clock.label}  now=${clock.now().toISOString()}  window=${config.content_window_days}d back / ${config.events_window_days}d ahead`);
console.log("");

let failures = 0;
for (const source of config.sources) {
  if (!source.enabled) {
    console.log(`SKIP   ${source.id}  (disabled in config)`);
    continue;
  }
  const fetcher = fetcherFor(source.kind);
  if (!fetcher) {
    console.log(`SKIP   ${source.id}  (fetcher for kind "${source.kind}" not built yet)`);
    continue;
  }
  const started = Date.now();
  const r = await fetcher.fetch(source, { config, clock });
  const ms = Date.now() - started;
  if (r.error) {
    failures++;
    console.log(`FAIL   ${source.id}  ${r.error}  (${ms} ms)`);
    continue;
  }
  const edge = r.items[0]?.date ?? "-";
  const edgeLabel = source.type === "event" ? "next" : "newest";
  const status = r.items.length === 0 ? "EMPTY " : "OK    ";
  if (r.items.length === 0) failures++;
  console.log(`${status} ${source.id}  items=${r.items.length}  ${edgeLabel}=${edge}  bytes=${r.bytes}  (${ms} ms)`);
  for (const it of r.items.slice(0, 5)) console.log(`         - ${it.date.slice(0, 10)}  ${it.title}\n           ${it.link}`);
  if (r.items.length > 5) console.log(`         ... and ${r.items.length - 5} more`);
  for (const w of r.warnings) console.log(`         ! ${w}`);
}

console.log("");
if (failures) {
  console.log(`${failures} source(s) failed or returned nothing. A human should look before newsletter day.`);
  // exitCode, not process.exit(): exiting with open sockets trips a libuv assertion on Windows.
  process.exitCode = 1;
} else {
  console.log("all built sources returned items");
}
