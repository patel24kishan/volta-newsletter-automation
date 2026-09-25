/**
 * What the build must carry and must leave behind. The build itself is exercised by
 * test/dist.int.test.ts; this pins the two lists that decide what a user installs.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { COPIES } from "../scripts/build.mjs";

const root = resolve(import.meta.dirname, "..");
const buildConfig = JSON.parse(readFileSync(join(root, "tsconfig.build.json"), "utf8")) as { exclude: string[]; include: string[] };
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { bin: Record<string, string>; files: string[]; dependencies: Record<string, string>; devDependencies: Record<string, string>; engines: { node: string }; private?: boolean };

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
}

describe("the package build", () => {
  it("copies the panel's script, which tsc never sees, to where panel.ts reads it", () => {
    expect(COPIES).toContainEqual({ from: "src/mcp/panel-client.js", to: "dist/mcp/panel-client.js" });
  });

  it("leaves out every file that imports the retired Slack surface's dependency", () => {
    const importers = walk(join(root, "src")).filter((f) => f.endsWith(".ts") && readFileSync(f, "utf8").includes("@slack/bolt")).map((f) => relative(root, f).replace(/\\/g, "/"));
    expect(importers.length).toBeGreaterThan(0);
    for (const f of importers) expect(buildConfig.exclude).toContain(f);
    expect(pkg.dependencies["@slack/bolt"]).toBeUndefined();
    expect(pkg.devDependencies["@slack/bolt"]).toBeDefined();
  });

  it("is publishable: a bin, the shipped folders, the Node floor, and not private", () => {
    expect(pkg.private).toBeUndefined();
    expect(pkg.bin).toEqual({ "volta-newsletter": "dist/cli/main.js" });
    expect(pkg.files).toEqual(expect.arrayContaining(["dist", "config", "README.md"]));
    expect(pkg.engines.node).toBe(">=22.13");
    expect(pkg.devDependencies.tsx).toBeDefined();
    expect(pkg.dependencies.tsx).toBeUndefined();
  });
});
