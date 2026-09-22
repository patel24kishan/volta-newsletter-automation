// Adds (or updates) the volta-newsletter entry in the Claude desktop app's config.
//
// Run it while the Claude app is fully quit: the app keeps its own copy of this file and writes it
// back when it saves preferences, so an entry added while it runs is lost.
//
//   node "W:\AI Projects\Week 2\NewsLetter\bin\add-to-claude-config.mjs"            dry run (default)
//   node "W:\AI Projects\Week 2\NewsLetter\bin\add-to-claude-config.mjs" --live     live
//   ... --now=2026-10-01T08:30:00-03:00                                                test as that date (dry run only)
//
// Everything else in the config is kept, and a backup is written next to it first.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appData = process.env.APPDATA;
if (!appData) {
  console.error("APPDATA is not set; this script is for the Claude app on Windows.");
  process.exit(1);
}
// Installed from the Microsoft Store, the app keeps its AppData in a private copy under
// %LOCALAPPDATA%/Packages/Claude_<id>/LocalCache/Roaming, and never reads %APPDATA%/Claude.
function storeConfigDir() {
  const packages = join(process.env.LOCALAPPDATA ?? "", "Packages");
  if (!process.env.LOCALAPPDATA || !existsSync(packages)) return undefined;
  const pkg = readdirSync(packages).find((d) => /^Claude_/i.test(d));
  return pkg ? join(packages, pkg, "LocalCache", "Roaming", "Claude") : undefined;
}
const dir = storeConfigDir() ?? join(appData, "Claude");
mkdirSync(dir, { recursive: true });
const file = join(dir, "claude_desktop_config.json");
const launcher = join(dirname(fileURLToPath(import.meta.url)), "mcp-server.mjs").replace(/\\/g, "/");
const live = process.argv.includes("--live");
const now = process.argv.find((a) => a.startsWith("--now="));
const demoClock = process.argv.includes("--demo-clock");
if (live && now && !demoClock) {
  console.error("Refusing --live together with --now: add --demo-clock for a deliberate live demo on that date.");
  process.exit(1);
}

const config = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
if (existsSync(file)) {
  const backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  copyFileSync(file, backup);
  console.log(`backup: ${backup}`);
}
config.mcpServers = {
  ...(config.mcpServers ?? {}),
  "volta-newsletter": {
    command: "node",
    args: [launcher, ...(now ? [now] : [])],
    env: { ALLOW_LIVE: live ? "1" : "0", ...(live && now ? { ALLOW_LIVE_WITH_DEMO_CLOCK: "1" } : {}) },
  },
};
writeFileSync(file, JSON.stringify(config, null, 2));
console.log(`added volta-newsletter to ${file}`);
console.log(JSON.stringify(config.mcpServers["volta-newsletter"], null, 2));
console.log("Now open the Claude app.");
