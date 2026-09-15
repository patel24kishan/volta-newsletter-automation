import { describe, expect, it } from "vitest";
import { assertLive, DryRunRefusal, isLive } from "../src/runtime.js";

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
});
