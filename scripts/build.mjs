// Builds the package: plain tsc emit into dist/, then the one file tsc does not know about.
//
// Why tsc and not a bundler: src/mcp/panel.ts resolves @modelcontextprotocol/ext-apps through
// createRequire and reads panel-client.js from beside itself at run time. A single-file bundle
// breaks both; a directory of compiled files with the same layout as src keeps them working.
// tsconfig.build.json leaves out the retired Slack surface, so @slack/bolt is not shipped.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Files copied verbatim into dist because something reads them at run time. */
export const COPIES = [
  { from: "src/mcp/panel-client.js", to: "dist/mcp/panel-client.js" },
];

export function build({ log = (s) => console.error(s) } = {}) {
  rmSync(join(root, "dist"), { recursive: true, force: true });
  const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
  log("tsc -p tsconfig.build.json");
  execFileSync(process.execPath, [tsc, "-p", join(root, "tsconfig.build.json")], { cwd: root, stdio: "inherit" });
  for (const c of COPIES) {
    mkdirSync(dirname(join(root, c.to)), { recursive: true });
    copyFileSync(join(root, c.from), join(root, c.to));
    log(`copy ${c.from} -> ${c.to}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) build();
