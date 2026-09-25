/**
 * The newsletter as an MCP server over stdio. Any host that can start a command and talk MCP to
 * it — the Claude app, Cursor, Codex, Claude Code — starts this; the tools are in
 * src/mcp/newsletter-server.ts. Reached through src/cli/mcp-server.ts (or the package's main),
 * which checks the Node version before anything here is imported.
 *
 * stdout carries the protocol, so nothing else may ever be printed there: every log line goes to
 * stderr, which the host keeps in its MCP log.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createNewsletterServer } from "../mcp/newsletter-server.js";
import { isLive } from "../runtime.js";
import { createDeps, loadEnvFiles, StartupProblem } from "./bootstrap.js";

// Before anything else can print: a stray console.log would corrupt the protocol.
console.log = (...args: unknown[]) => console.error(...args);
const log = (line: string) => console.error(`volta-newsletter: ${line}`);

const env = process.env;
loadEnvFiles(env, process.cwd());

let boot;
try {
  boot = await createDeps({ env, argv: process.argv.slice(2), log });
} catch (e) {
  if (e instanceof StartupProblem) {
    log(e.message);
    process.exit(1);
  }
  throw e;
}

const server = createNewsletterServer(boot.deps);
await server.connect(new StdioServerTransport());
log(`ready (${isLive(env) ? "LIVE" : "dry run"}, clock ${boot.clock.label}, ${boot.config.cadence ?? "weekly"}); data in ${boot.paths.dataDir}, config ${boot.paths.configPath}`);

const shutdown = async () => {
  await server.close().catch(() => undefined);
  await boot.close();
  process.exit(0);
};
process.stdin.on("close", () => void shutdown());
for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => void shutdown());
