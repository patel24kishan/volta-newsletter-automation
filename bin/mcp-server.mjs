// Launcher for a checkout, used by the Claude app entry that bin/add-to-claude-config.mjs writes.
// The app starts MCP servers from its own folder, where `node --import tsx` cannot find tsx;
// imported from here, it is found in this project's node_modules instead.
//
// A checkout keeps its data in ./out and reads ./demo/config.json, as it always has; an
// installed package keeps them in the user's data folder instead (src/install/paths.ts).
// Point claude_desktop_config.json at this file: "command": "node", "args": ["<project>/bin/mcp-server.mjs"].
import { resolve } from "node:path";
import { register } from "tsx/esm/api";

const root = resolve(import.meta.dirname, "..");
process.chdir(root);
process.env.VOLTA_NEWSLETTER_HOME ??= resolve(root, "out");
process.env.CONFIG_PATH ??= resolve(root, "demo/config.json");

register();
await import("../src/cli/mcp-server.ts");
