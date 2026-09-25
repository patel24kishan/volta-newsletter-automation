// Packs the Claude Desktop extension: a .mcpb file wrapping the same compiled dist/ the npm
// package ships. mcpb pack takes a whole directory, so everything the bundle needs is first
// copied into a staging folder outside the repo — dist/, config/, package.json,
// package-lock.json and manifest.json — and production dependencies are installed there with
// npm ci, so node_modules holds exactly what the entry point imports at runtime: no src/, no
// test/, no @slack/bolt (a devDependency since the build excludes its only importer), no tsx.
import { execFileSync, execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, root } from "./build.mjs";

const OUT_DIR = resolve(root, "dist-mcpb");

export function pack({ log = (s) => console.error(s), skipBuild = false } = {}) {
  if (!skipBuild) build({ log });
  if (!existsSync(join(root, "dist", "cli", "main.js"))) throw new Error("dist/cli/main.js is missing; run the build first");

  const staging = mkdtempSync(join(tmpdir(), "volta-mcpb-"));
  log(`staging in ${staging}`);
  for (const item of ["dist", "config", "manifest.json", "package.json", "package-lock.json"]) {
    cpSync(join(root, item), join(staging, item), { recursive: true });
  }

  // npm itself is a .cmd shim on Windows and needs a shell either way, so this one call uses
  // execSync (a command string) rather than execFileSync (a file plus an args array, which Node
  // warns about when combined with shell:true). The command is a fixed literal, not input from
  // this script's own caller.
  log("npm ci --omit=dev (production dependencies only)");
  execSync("npm ci --omit=dev --no-audit --no-fund", { cwd: staging, stdio: "inherit" });

  mkdirSync(OUT_DIR, { recursive: true });
  // Run mcpb's CLI file with node directly rather than through its .bin shim: a shim needs
  // cmd.exe on Windows, and this project's own path ("...\Week 2\...") always has a space that
  // shell quoting would have to get right on every OS. execFileSync passes args as a real argv
  // array when there is no shell, so nothing needs escaping here.
  // @anthropic-ai/mcpb's "exports" map does not expose this file for require()/import, but a
  // plain filesystem path is not subject to that restriction. "./node" is exported, so its
  // resolved path (.../dist/node.js) locates the package root reliably across npm layouts.
  const require = createRequire(import.meta.url);
  const nodeEntry = require.resolve("@anthropic-ai/mcpb/node");
  const packageRoot = nodeEntry.slice(0, nodeEntry.indexOf(join("dist", "node.js")));
  const mcpbCli = join(packageRoot, "dist", "cli", "cli.js");
  log(`mcpb pack ${staging} -> ${OUT_DIR}`);
  execFileSync(process.execPath, [mcpbCli, "pack", staging, join(OUT_DIR, "volta-newsletter.mcpb")], { stdio: "inherit" });

  rmSync(staging, { recursive: true, force: true });
  const outFile = join(OUT_DIR, "volta-newsletter.mcpb");
  log(`done: ${outFile}`);
  return outFile;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) pack();
