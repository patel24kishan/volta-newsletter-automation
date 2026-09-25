/**
 * The one hard requirement on the machine: node:sqlite, which is built into Node from 22.13
 * without a flag. On an older Node the import fails with a bare module error that says nothing
 * about what to do, so the entry point checks first and says it in one sentence.
 */
export const MIN_NODE = "22.13.0";

function parse(version: string): [number, number, number] | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

/** The sentence to print when this Node is too old, or undefined when it will do. */
export function nodeVersionProblem(version: string, min: string = MIN_NODE): string | undefined {
  const have = parse(version);
  const need = parse(min);
  if (!have || !need) return undefined; // an unrecognised version string is not a reason to refuse
  for (let i = 0; i < 3; i++) {
    if (have[i]! > need[i]!) return undefined;
    if (have[i]! < need[i]!) return `volta-newsletter needs Node ${min} or newer (for node:sqlite); this is Node ${have.join(".")}. Install a newer Node, or point the host at one.`;
  }
  return undefined;
}
