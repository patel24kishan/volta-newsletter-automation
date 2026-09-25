/**
 * Dry-run is the default (CLAUDE.md section 4). Anything that sends, posts, or publishes
 * must check isLive() and refuse otherwise.
 *
 * "1" is the documented value everywhere a human sets it by hand (.env, the README, this
 * project's own docs). "true" is accepted too, because the Claude Desktop extension's settings
 * form offers live mode as a boolean toggle, and its host stringifies that value when it
 * substitutes it into an env string; the exact form is not documented publicly, so both are
 * accepted rather than guessed at. Anything else — unset, "0", "false" — stays dry run, which is
 * the direction a wrong guess must fail in.
 */
export function isLive(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ALLOW_LIVE === "1" || env.ALLOW_LIVE === "true";
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
