/**
 * Integration: the real entry point, started the way a host starts it — as a child process over
 * stdio, from some other folder, with nothing but environment variables. This is the path no
 * in-memory test reaches: paths outside the checkout, the .env rule, and a half-filled email
 * configuration that must not kill the process.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repo = resolve(import.meta.dirname, "..");
const entry = join(repo, "src", "cli", "mcp-server.ts");
// tsx's own CLI, so the TypeScript entry runs unbuilt from any working directory.
const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "volta-entry-")); mkdirSync(join(dir, "elsewhere")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

async function start(env: Record<string, string>) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [tsxCli, entry],
    cwd: join(dir, "elsewhere"),
    env: { ...(process.env.PATH ? { PATH: process.env.PATH } : {}), ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}), ...env },
    stderr: "pipe",
  });
  const client = new Client({ name: "host", version: "1" });
  await client.connect(transport);
  const status = async () => {
    const r = (await client.callTool({ name: "newsletter_status", arguments: {} })) as { content: Array<{ text: string }> };
    return r.content.map((c) => c.text).join("\n");
  };
  return { client, status, close: () => client.close() };
}

describe("the entry point, started by a host", { timeout: 60_000 }, () => {
  it("keeps its data where VOLTA_NEWSLETTER_HOME says, reads the packaged config, and needs no .env", async () => {
    const data = join(dir, "data");
    const { status, close } = await start({ VOLTA_NEWSLETTER_HOME: data, DEMO_NOW: "2026-10-01T11:30:00Z", ALLOW_LIVE: "0" });
    try {
      const s = await status();
      expect(s).toContain("Period: 2026-10");
      expect(s).toContain("Email platform: not configured (approve saves the file only)");
      expect(existsSync(join(data, "newsletter.sqlite"))).toBe(true);
    } finally {
      await close();
    }
  });

  it("starts with a half-filled email configuration and names the missing value", async () => {
    const data = join(dir, "data");
    const { status, close } = await start({ VOLTA_NEWSLETTER_HOME: data, DEMO_NOW: "2026-10-01T11:30:00Z", MAILCHIMP_API_KEY: "k-us21", MAILCHIMP_LIST_ID: "L1" });
    try {
      expect(await status()).toContain("not configured (MAILCHIMP_REPLY_TO is not set (the verified email on the Mailchimp account); approve saves the file only)");
    } finally {
      await close();
    }
  });

  it("reads a .env in the data directory, which is how a scheduled run gets its settings", async () => {
    const data = join(dir, "data");
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, ".env"), "DEMO_NOW=2026-11-02T11:30:00Z\n");
    const { status, close } = await start({ VOLTA_NEWSLETTER_HOME: data });
    try {
      expect(await status()).toContain("Period: 2026-11");
    } finally {
      await close();
    }
  });
});
