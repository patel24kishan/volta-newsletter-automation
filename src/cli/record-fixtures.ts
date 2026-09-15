/**
 * Records the raw body of each live source into test/fixtures so parser tests are deterministic
 * while the demo itself stays live. Re-run whenever a source's markup changes.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { loadConfig } from "../config.js";
import { fetchText } from "../http.js";

const EXT: Record<string, string> = { rss: "xml", ics: "ics", linkedin_company: "html" };

const config = await loadConfig(process.env.CONFIG_PATH ?? "demo/config.json");
await mkdir("test/fixtures", { recursive: true });

for (const source of config.sources) {
  const path = `test/fixtures/${source.id}.${EXT[source.kind] ?? "txt"}`;
  try {
    const body = await fetchText(source.url);
    await writeFile(path, body, "utf8");
    console.log(`recorded ${source.id} -> ${path} (${body.length} bytes)`);
  } catch (e) {
    console.log(`FAILED  ${source.id}: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}
