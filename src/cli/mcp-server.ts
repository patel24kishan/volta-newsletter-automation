/**
 * Entry point for the MCP server. It only checks the Node version and then loads the server
 * (src/cli/mcp-start.ts): node:sqlite is imported there, and on an old Node that import fails
 * with a message that says nothing about what to do. Imports are hoisted, so the check has to
 * live in a file that imports nothing of its own.
 *
 * Usage (normally run by the host, not by hand):
 *   npx tsx src/cli/mcp-server.ts                  dry run: nothing is created in or sent from Mailchimp
 *   ALLOW_LIVE=1 npx tsx src/cli/mcp-server.ts     live
 *   ... -- --now=2026-10-01T08:30:00-03:00     as if it were that moment (dry run only)
 */
import { nodeVersionProblem } from "../install/node-check.js";

const problem = nodeVersionProblem(process.version);
if (problem) {
  console.error(problem);
  process.exit(1);
}
await import("./mcp-start.js");
