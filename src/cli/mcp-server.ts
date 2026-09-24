/**
 * The newsletter as an MCP server for the Claude desktop app. Claude starts this process itself
 * (see the "volta-newsletter" entry in claude_desktop_config.json) and talks to it over stdin and
 * stdout; the tools are in src/mcp/newsletter-server.ts.
 *
 * Usage (normally run by the Claude app, not by hand):
 *   npx tsx src/cli/mcp-server.ts                  dry run: nothing is created in or sent from Mailchimp
 *   ALLOW_LIVE=1 npx tsx src/cli/mcp-server.ts     live
 *   ... -- --now=2026-10-01T08:30:00-03:00     as if it were that moment (dry run only)
 *
 * stdout carries the protocol, so nothing else may ever be printed there: every log line goes to
 * stderr, which the Claude app keeps in its MCP log.
 */
import { resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConsoleFileAlerter } from "../alerts.js";
import { loadDotEnv } from "../cli/env.js";
import { resolveClock } from "../clock.js";
import { loadConfig } from "../config.js";
import { mailchimpFromEnv } from "../publish/mailchimp.js";
import { fetchText } from "../http.js";
import { runWeek } from "../run-week.js";
import { isLive, liveClockProblem } from "../runtime.js";
import { SqliteStorage } from "../storage.js";
import { startPreviewServer } from "../surface/preview-server.js";
import { createNewsletterServer } from "../mcp/newsletter-server.js";

// Before anything else can print: a stray console.log would corrupt the protocol.
console.log = (...args: unknown[]) => console.error(...args);

// The Claude app starts this from its own folder, so every path is taken from the project root.
const root = resolve(import.meta.dirname, "../..");
process.chdir(root);
loadDotEnv();
const env = process.env;
const clock = resolveClock(process.argv.slice(2), env);
const clockProblem = liveClockProblem(env, clock);
if (clockProblem) {
  console.error(`volta-newsletter: ${clockProblem}`);
  process.exit(1);
}
const config = await loadConfig(env.CONFIG_PATH ?? "demo/config.json");
const outDir = env.OUT_DIR ?? "out";
const storage = new SqliteStorage(env.DATABASE_PATH ?? `${outDir}/newsletter.sqlite`);
const alerter = new ConsoleFileAlerter(`${outDir}/alerts.log`, () => clock.now());

const publisher = mailchimpFromEnv(env);
let audience: { audienceName: string; memberCount: number } | undefined;
if (publisher) {
  try {
    audience = await publisher.verify();
  } catch (e) {
    alerter.alert("error", "email", `${publisher.platform} is unreachable: ${(e as Error).message}`, "approve will say so; check the API key and audience id");
  }
}

let preview: Promise<{ put(html: string, id?: string): string; close(): Promise<void> } | undefined> | undefined;
const server = createNewsletterServer({
  config, clock, storage, alerter, outDir, env,
  runPeriod: () => runWeek({ config, clock, storage, alerter, outDir }),
  fetchText,
  ...(publisher ? { publisher } : {}),
  ...(audience ? { audience } : {}),
  preview: () => (preview ??= startPreviewServer().catch((e: unknown) => {
    console.error(`volta-newsletter: preview not available: ${(e as Error).message}`);
    return undefined;
  })),
});

await server.connect(new StdioServerTransport());
console.error(`volta-newsletter: ready (${isLive(env) ? "LIVE" : "dry run"}, clock ${clock.label}, ${config.cadence ?? "weekly"})`);

const shutdown = async () => {
  await server.close().catch(() => undefined);
  await (await preview)?.close().catch(() => undefined);
  storage.close();
  process.exit(0);
};
process.stdin.on("close", () => void shutdown());
for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => void shutdown());
