// Launcher for the Claude app. The app starts MCP servers from its own folder, where `node --import
// tsx` cannot find tsx; imported from here, it is found in this project's node_modules instead.
// Point claude_desktop_config.json at this file: "command": "node", "args": ["<project>/bin/mcp-server.mjs"].
import { register } from "tsx/esm/api";

register();
await import("../src/cli/mcp-server.ts");
