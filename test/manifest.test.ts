/**
 * The Claude Desktop extension manifest, checked against the code rather than trusted by hand:
 * every placeholder it uses has a matching setting, every env var it sets is one the code
 * actually reads, its declared Node floor matches the package's, and it validates against
 * @anthropic-ai/mcpb's own schema. Packing a real .mcpb (scripts/pack-mcpb.mjs) is exercised by
 * hand — it runs a full build and an npm install — not on every test run.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ENV_NAMES } from "../src/install/env.js";

const root = resolve(import.meta.dirname, "..");
interface UserConfigEntry { type: string; title: string; description: string; sensitive?: boolean; required?: boolean; default?: unknown }
interface Manifest {
  manifest_version: string;
  name: string;
  version: string;
  server: { type: string; entry_point: string; mcp_config: { command: string; args: string[]; env: Record<string, string> } };
  user_config: Record<string, UserConfigEntry>;
  compatibility: { platforms: string[]; runtimes: { node: string } };
}
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as Manifest;
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string; engines: { node: string } };

describe("the Claude Desktop extension manifest", () => {
  it("validates against @anthropic-ai/mcpb's own schema", async () => {
    const { validateManifest } = await import("@anthropic-ai/mcpb/node");
    expect(validateManifest(join(root, "manifest.json"))).toBe(true);
  });

  it("matches the package's version and Node floor, so the two cannot drift apart", () => {
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.compatibility.runtimes.node.replace(/^>=/, "")).toBe(pkg.engines.node.replace(/^>=/, "") + ".0");
  });

  it("points at the compiled entry point that npm run build produces", () => {
    expect(manifest.server.entry_point).toBe("dist/cli/main.js");
    expect(manifest.server.mcp_config.args).toEqual(["${__dirname}/dist/cli/main.js", "serve"]);
  });

  it("gives every ${user_config.X} placeholder a matching setting, and declares no others", () => {
    const used = Object.values(manifest.server.mcp_config.env).map((v) => /^\$\{user_config\.(\w+)\}$/.exec(v)?.[1]);
    expect(used.every(Boolean), JSON.stringify(manifest.server.mcp_config.env)).toBe(true);
    expect(new Set(used)).toEqual(new Set(Object.keys(manifest.user_config)));
  });

  it("sets only env vars the code actually reads, under a name that appears in the source of truth", () => {
    const keys = Object.keys(manifest.server.mcp_config.env);
    for (const k of keys) expect(ENV_NAMES, k).toContain(k);
  });

  it("marks the two credentials as sensitive and nothing else", () => {
    expect(manifest.user_config.mailchimp_api_key?.sensitive).toBe(true);
    expect(manifest.user_config.slack_bot_token?.sensitive).toBe(true);
    for (const [name, cfg] of Object.entries(manifest.user_config)) {
      if (name === "mailchimp_api_key" || name === "slack_bot_token") continue;
      expect(cfg.sensitive, name).not.toBe(true);
    }
  });

  it("starts in dry run: live_mode defaults false", () => {
    expect(manifest.user_config.live_mode).toMatchObject({ type: "boolean", default: false });
  });

  it("leaves nothing required, so an install with no Mailchimp account still starts", () => {
    for (const [name, cfg] of Object.entries(manifest.user_config)) expect(cfg.required, name).not.toBe(true);
  });
});
