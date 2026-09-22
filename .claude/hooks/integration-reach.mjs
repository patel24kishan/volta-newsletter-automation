// Which of the given source files no integration test reaches.
//
// Usage: node .claude/hooks/integration-reach.mjs src/a.ts src/b.ts ...
// Prints one unreached file per line; prints nothing when every file is reached.
//
// Integration tests are test/integration.test.ts, test/run-week.test.ts and any test/*.int.test.ts:
// the ones that run a feature together with the rest of the pipeline. "Reached" means the file is
// imported by one of them, directly or through other source files, following relative imports.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";

const root = process.cwd();
const INTEGRATION = new Set(["integration.test.ts", "run-week.test.ts"]);
const entries = readdirSync(join(root, "test"))
  .filter((f) => INTEGRATION.has(f) || f.endsWith(".int.test.ts"))
  .map((f) => join(root, "test", f));

const IMPORT = /(?:import|export)\s[^;]*?from\s+["'](\.{1,2}\/[^"']+)["']|import\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g;

/** A relative import as written (".js" in TypeScript ESM) to the .ts file on disk. */
function resolve(fromFile, spec) {
  const base = join(dirname(fromFile), spec);
  for (const c of [base.replace(/\.js$/, ".ts"), base, `${base}.ts`, join(base, "index.ts")]) {
    if (existsSync(c) && c.endsWith(".ts")) return normalize(c);
  }
  return undefined;
}

const reached = new Set();
const queue = [...entries];
while (queue.length) {
  const file = queue.pop();
  if (reached.has(file)) continue;
  reached.add(file);
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(IMPORT)) {
    const target = resolve(file, m[1] ?? m[2]);
    if (target && !reached.has(target)) queue.push(target);
  }
}

const reachedRel = new Set([...reached].map((f) => relative(root, f).replace(/\\/g, "/")));
for (const f of process.argv.slice(2)) {
  if (!reachedRel.has(f.replace(/\\/g, "/"))) console.log(f);
}
