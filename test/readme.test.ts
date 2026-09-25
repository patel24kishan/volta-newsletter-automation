/**
 * The README is what a friend installs from, so its snippets are checked against the code: every
 * setting a curator must give appears in each host's config, the JSON blocks parse, the reminder
 * recipes are the very strings newsletter_status prints, and the tool count is the real one.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CURATOR_ENV_NAMES, ENV_NAMES } from "../src/install/env.js";
import { RECIPES, REMINDER_COMMAND } from "../src/reminder/recipes.js";

const readme = readFileSync(join(resolve(import.meta.dirname, ".."), "README.md"), "utf8");

/** Fenced code blocks, with their language tag. */
function blocks(): Array<{ lang: string; code: string }> {
  return [...readme.matchAll(/```(\w*)\n([\s\S]*?)```/g)].map((m) => ({ lang: m[1] ?? "", code: m[2] ?? "" }));
}
const REQUIRED = ["MAILCHIMP_API_KEY", "MAILCHIMP_LIST_ID", "MAILCHIMP_REPLY_TO", "SLACK_BOT_TOKEN"];

describe("the README's install snippets", () => {
  it("give every host the same required settings, and the JSON ones parse", () => {
    const json = blocks().filter((b) => b.lang === "json");
    expect(json).toHaveLength(2); // Claude Desktop, Cursor
    for (const b of json) {
      const cfg = JSON.parse(b.code) as { mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> };
      const entry = cfg.mcpServers["volta-newsletter"]!;
      expect(entry.command).toBe("npx");
      expect(entry.args).toEqual(["-y", "volta-newsletter"]);
      expect(Object.keys(entry.env)).toEqual(REQUIRED);
    }
    const toml = blocks().find((b) => b.lang === "toml")!.code;
    expect(toml).toContain("[mcp_servers.volta-newsletter]");
    for (const k of REQUIRED) expect(toml).toContain(`${k} = ""`);
    const code = blocks().find((b) => b.lang === "bash")!.code;
    expect(code).toContain("claude mcp add volta-newsletter");
    for (const k of REQUIRED) expect(code).toContain(`-e ${k}=`);
    expect(code).toContain("-- npx -y volta-newsletter");
  });

  it("documents every setting the curator can give, under the name the code reads", () => {
    const table = readme.slice(readme.indexOf("| Setting |"), readme.indexOf("### Claude Desktop"));
    for (const name of CURATOR_ENV_NAMES) expect(table, name).toContain(`\`${name}\``);
    // And nothing the code does not read.
    for (const m of table.matchAll(/`([A-Z_]+)`/g)) expect(ENV_NAMES, m[1]).toContain(m[1]!);
  });

  it("prints the reminder recipes exactly as newsletter_status does", () => {
    expect(readme).toContain(RECIPES.win32.setup);
    expect(readme).toContain(`35 8 * * * ${REMINDER_COMMAND}`);
    expect(readme).toContain("<string>com.volta-newsletter.reminder</string>");
    expect(readme).toContain("<key>Hour</key><integer>8</integer><key>Minute</key><integer>35</integer>");
  });

  it("names the tools it counts", () => {
    const m = /\*\*MCP server\*\* \| (\d+) tools: (.+?)\. \|/.exec(readme)!;
    const named = m[2]!.match(/`(\w+)`/g)!.map((s) => s.replace(/`/g, ""));
    expect(named).toHaveLength(Number(m[1]));
    expect(named.sort()).toEqual(["add_event", "add_source", "approve_draft", "build_draft", "edit_item", "list_candidates", "list_sources", "monthly_reminder", "newsletter_status", "prepare_month", "remove_event", "remove_source", "send_campaign", "set_selection", "set_source", "set_up_newsletter"]);
  });
});
