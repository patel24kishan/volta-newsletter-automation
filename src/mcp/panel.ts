/**
 * The review panel: an MCP App (interactive page) the Claude app shows in the chat when the
 * candidates are listed. Checkboxes, per-item edit forms, Add an event and Build the draft, all of
 * which call the same tools as the chat, so every rule still applies. Approve and send stay in the
 * chat, where Claude confirms with the curator first.
 *
 * The page is one self-contained HTML document: the MCP Apps browser library is inlined, since the
 * host shows it in a sandbox that loads nothing from the network.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export const PANEL_URI = "ui://volta-newsletter/review-panel.html";
/** The MCP Apps content type; the host renders a resource of this type as an app. */
export const PANEL_MIME = "text/html;profile=mcp-app";

/**
 * The library ships as an ES module ending in `export{local as Name,...}`. An inline script cannot
 * import it by name, so each export statement becomes an assignment to `globalThis.__mcpApps`,
 * which the panel's own script reads.
 */
export function exposeExports(bundle: string): string {
  let found = 0;
  const out = bundle.replace(/export\s*\{([^}]*)\};?/g, (_all, list: string) => {
    found++;
    const pairs = list.split(",").map((p) => p.trim()).filter(Boolean).map((p) => {
      const m = /^([\w$]+)(?:\s+as\s+([\w$]+))?$/.exec(p);
      if (!m) throw new Error(`unexpected export in the MCP Apps bundle: ${p}`);
      return `${m[2] ?? m[1]}:${m[1]}`;
    });
    return `Object.assign(globalThis.__mcpApps||(globalThis.__mcpApps={}),{${pairs.join(",")}});`;
  });
  if (found === 0) throw new Error("the MCP Apps bundle has no export statement to expose");
  return out;
}

const CSS = `
:root{color-scheme:light dark;--bg:var(--color-background-primary,#fff);--fg:var(--color-text-primary,#1f1f1d);--muted:var(--color-text-secondary,#6b6a64);--line:var(--color-border-primary,#dcdad2);--accent:var(--color-text-info,#185fa5);--warn-bg:#faeeda;--warn-fg:#633806}
@media (prefers-color-scheme:dark){:root{--bg:var(--color-background-primary,#1f1f1d);--fg:var(--color-text-primary,#f1efe8);--muted:var(--color-text-secondary,#b4b2a9);--line:var(--color-border-primary,#444441);--accent:var(--color-text-info,#85b7eb);--warn-bg:#633806;--warn-fg:#fac775}}
*{box-sizing:border-box}body{margin:0;padding:12px;font:14px/1.5 var(--font-sans,system-ui,sans-serif);background:var(--bg);color:var(--fg)}
.head{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;margin-bottom:6px}.muted{color:var(--muted)}
.badge,.tag{font-size:12px;border:1px solid var(--line);border-radius:4px;padding:0 6px}.tag.hold{background:var(--warn-bg);color:var(--warn-fg);border-color:transparent;margin-right:6px}
h3{font-size:15px;font-weight:500;margin:14px 0 6px}ul.items{list-style:none;margin:0;padding:0}ul.items>li{border-top:1px solid var(--line);padding:8px 0}
.line{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;cursor:pointer}.title{font-weight:500}.detail{margin:4px 0 0 26px}
ul.prints{margin:2px 0;padding-left:18px}.hold-note{color:var(--warn-fg);background:var(--warn-bg);padding:2px 6px;border-radius:4px;display:inline-block;margin:2px 0}.note{color:var(--muted);font-size:13px}
button{font:inherit;padding:4px 10px;border:1px solid var(--line);border-radius:6px;background:transparent;color:var(--fg);cursor:pointer}button.primary{border-color:var(--accent);color:var(--accent)}button.link{border:0;padding:0;color:var(--accent);text-decoration:underline}
button:focus-visible,input:focus-visible,textarea:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.form{display:grid;gap:4px;margin:8px 0 4px 26px;max-width:520px}.form input,.form textarea{font:inherit;padding:4px 6px;border:1px solid var(--line);border-radius:6px;background:transparent;color:var(--fg)}
.row{display:flex;gap:8px;flex-wrap:wrap;margin-top:6px}details.add{margin-top:14px}details.add .form{margin-left:0}.actions{margin-top:14px;display:grid;gap:8px}.draft{display:grid;gap:4px}
.status{min-height:1.2em;font-size:13px;color:var(--muted)}.status.error{color:var(--color-text-danger,#a32d2d)}
`;

let cached: string | undefined;

/** The panel page, built once per process. */
export function panelHtml(): string {
  if (cached) return cached;
  const bundlePath = createRequire(import.meta.url).resolve("@modelcontextprotocol/ext-apps/app-with-deps");
  const library = exposeExports(readFileSync(bundlePath, "utf8"));
  const client = readFileSync(fileURLToPath(new URL("./panel-client.js", import.meta.url)), "utf8");
  // Inline scripts end at the first "</script", so any in the library would end it early.
  const safe = (js: string) => js.replace(/<\/script/gi, "<\\/script");
  cached = [
    "<!DOCTYPE html>",
    '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    "<title>Volta newsletter review</title>",
    `<style>${CSS}</style></head>`,
    '<body><main id="root"><p class="muted">Loading the candidates…</p></main>',
    // Two module scripts: they run in order but keep separate scopes, so the library's minified
    // names cannot collide with the panel's own.
    `<script type="module">${safe(library)}</script>`,
    `<script type="module">${safe(client)}</script>`,
    "</body></html>",
  ].join("\n");
  return cached;
}
