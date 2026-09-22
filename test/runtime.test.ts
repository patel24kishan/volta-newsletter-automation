import { describe, expect, it } from "vitest";
import { assertLive, DryRunRefusal, isLive, liveClockProblem } from "../src/runtime.js";

describe("dry-run default", () => {
  it("is not live unless ALLOW_LIVE=1 exactly", () => {
    expect(isLive({})).toBe(false);
    expect(isLive({ ALLOW_LIVE: "true" })).toBe(false);
    expect(isLive({ ALLOW_LIVE: "0" })).toBe(false);
    expect(isLive({ ALLOW_LIVE: "1" })).toBe(true);
  });

  it("assertLive refuses with a message naming the action", () => {
    expect(() => assertLive("send the Slack reminder", {})).toThrow(DryRunRefusal);
    expect(() => assertLive("send the Slack reminder", {})).toThrow(/send the Slack reminder/);
    expect(() => assertLive("send", { ALLOW_LIVE: "1" })).not.toThrow();
  });

  it("refuses live with a demo clock unless ALLOW_LIVE_WITH_DEMO_CLOCK=1 opts in", () => {
    const fake = { overridden: true };
    expect(liveClockProblem({ ALLOW_LIVE: "1" }, fake)).toMatch(/refusing to run live with the clock overridden/);
    expect(liveClockProblem({ ALLOW_LIVE: "1", ALLOW_LIVE_WITH_DEMO_CLOCK: "true" }, fake)).toBeDefined();
    expect(liveClockProblem({ ALLOW_LIVE: "1", ALLOW_LIVE_WITH_DEMO_CLOCK: "1" }, fake)).toBeUndefined();
    expect(liveClockProblem({}, fake)).toBeUndefined();
    expect(liveClockProblem({ ALLOW_LIVE: "1" }, { overridden: false })).toBeUndefined();
  });
});
