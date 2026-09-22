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

/**
 * Why the MCP server must not start, or undefined. Live with an overridden clock is refused, since
 * a wrong date could send real mail, unless ALLOW_LIVE_WITH_DEMO_CLOCK=1 opts in for a live demo.
 */
export function liveClockProblem(env: NodeJS.ProcessEnv, clock: { overridden: boolean }): string | undefined {
  if (!isLive(env) || !clock.overridden || env.ALLOW_LIVE_WITH_DEMO_CLOCK === "1") return undefined;
  return "refusing to run live with the clock overridden (--now or DEMO_NOW). Set ALLOW_LIVE_WITH_DEMO_CLOCK=1 for a deliberate live demo.";
}

/** Call before any side effect that reaches a human or an external system. */
export function assertLive(action: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!isLive(env)) throw new DryRunRefusal(action);
}
