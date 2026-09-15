/**
 * Dry-run is the default (CLAUDE.md section 4). Anything that sends, posts, or publishes
 * must check isLive() and refuse otherwise.
 */
export function isLive(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ALLOW_LIVE === "1";
}

export class DryRunRefusal extends Error {
  constructor(action: string) {
    super(`dry-run: refused to ${action}. Set ALLOW_LIVE=1 for a deliberate live run.`);
  }
}

/** Call before any side effect that reaches a human or an external system. */
export function assertLive(action: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!isLive(env)) throw new DryRunRefusal(action);
}
