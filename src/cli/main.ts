#!/usr/bin/env node
/**
 * The package's command: what `npx volta-newsletter` runs.
 *
 *   volta-newsletter [serve]     the MCP server over stdio (what a host's config points at)
 *   volta-newsletter --version
 *   volta-newsletter --help
 *
 * Any --now=<ISO> is passed on. This file imports nothing that needs node:sqlite, so the Node
 * version can be checked before the failing import would happen.
 */
import { createRequire } from "node:module";
import { nodeVersionProblem } from "../install/node-check.js";

const HELP = `volta-newsletter: a monthly newsletter reviewed inside your assistant.

  volta-newsletter [serve]   start the MCP server over stdio (this is what a host runs)
  volta-newsletter --version
  volta-newsletter --help

Settings come from environment variables; see the README for each host's config.`;

const args = process.argv.slice(2);
const command = args.find((a) => !a.startsWith("--")) ?? "serve";

if (args.includes("--help") || args.includes("-h")) {
  console.log(HELP);
} else if (args.includes("--version") || args.includes("-v")) {
  const pkg = createRequire(import.meta.url)("../../package.json") as { version: string };
  console.log(pkg.version);
} else if (command !== "serve") {
  console.error(`volta-newsletter: unknown command "${command}". Try --help.`);
  process.exit(2);
} else {
  const problem = nodeVersionProblem(process.version);
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
  await import("./mcp-start.js");
}
