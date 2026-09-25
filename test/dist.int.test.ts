/**
 * Integration: the compiled package, as a host installs it. Runs the real build, then starts
 * dist/cli/main.js over stdio from another folder and checks the two things compilation can
 * silently break: the tools are all there, and the review panel — which reads a copied file and
 * resolves a dependency through createRequire — still renders.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "../scripts/build.mjs";

const repo = resolve(import.meta.dirname, "..");
const main = join(repo, "dist", "cli", "main.js");
const TOOLS = ["add_event", "add_source", "approve_draft", "build_draft", "edit_item", "list_candidates", "list_sources", "monthly_reminder", "newsletter_status", "prepare_month", "remove_event", "remove_source", "send_campaign", "set_selection", "set_source", "set_up_newsletter"];

let dir: string;
beforeAll(() => {
  build({ log: () => undefined });
  dir = mkdtempSync(join(tmpdir(), "volta-dist-"));
  mkdirSync(join(dir, "elsewhere"));
}, 180_000);
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

const baseEnv = () => ({ ...(process.env.PATH ? { PATH: process.env.PATH } : {}), ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}) });

describe("the compiled package", { timeout: 60_000 }, () => {
  it("emits the entry, the panel script and no Slack surface", () => {
    expect(existsSync(main)).toBe(true);
    expect(existsSync(join(repo, "dist", "mcp", "panel-client.js"))).toBe(true);
    expect(existsSync(join(repo, "dist", "surface", "slack.js"))).toBe(false);
    expect(existsSync(join(repo, "dist", "cli", "serve.js"))).toBe(false);
    // Not only the excluded roots: nothing compiled may reach the dependency that is no longer shipped.
    const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
    const importers = walk(join(repo, "dist")).filter((f) => f.endsWith(".js") && readFileSync(f, "utf8").includes("@slack/bolt"));
    expect(importers).toEqual([]);
  });

  it("answers --version and --help, and refuses a command it does not know", () => {
    const pkg = JSON.parse(execFileSync(process.execPath, ["-p", "JSON.stringify(require('./package.json'))"], { cwd: repo, encoding: "utf8" })) as { version: string };
    expect(execFileSync(process.execPath, [main, "--version"], { encoding: "utf8" }).trim()).toBe(pkg.version);
    expect(execFileSync(process.execPath, [main, "--help"], { encoding: "utf8" })).toContain("start the MCP server");
    let failure: { status?: number; stderr?: string } | undefined;
    try { execFileSync(process.execPath, [main, "frobnicate"], { encoding: "utf8", stdio: "pipe" }); } catch (e) { failure = e as { status?: number; stderr?: string }; }
    expect(failure?.status).toBe(2);
    expect(failure?.stderr).toContain('unknown command "frobnicate"');
  });

  it("serves the sixteen tools and renders the review panel from dist", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath, args: [main, "serve"], cwd: join(dir, "elsewhere"),
      env: { ...baseEnv(), VOLTA_NEWSLETTER_HOME: join(dir, "data"), DEMO_NOW: "2026-10-01T11:30:00Z", ALLOW_LIVE: "0" },
      stderr: "pipe",
    });
    const client = new Client({ name: "host", version: "1" });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(TOOLS);
      const status = (await client.callTool({ name: "newsletter_status", arguments: {} })) as { content: Array<{ text: string }> };
      expect(status.content[0]?.text).toContain("Period: 2026-10");
      const panel = await client.readResource({ uri: "ui://volta-newsletter/review-panel.html" });
      const page = panel.contents[0] as { mimeType?: string; text?: string };
      expect(page.mimeType).toBe("text/html;profile=mcp-app");
      expect(page.text).toContain('<main id="root">');
      expect(page.text).toContain('new App({ name: "Newsletter review"'); // from the copied panel-client.js
      expect(existsSync(join(dir, "data", "newsletter.sqlite"))).toBe(true);
    } finally {
      await client.close();
    }
  });
});
