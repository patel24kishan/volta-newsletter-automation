import { describe, expect, it } from "vitest";
import { ClockError, localDateString, partsInZone, resolveClock } from "../src/clock.js";

describe("resolveClock", () => {
  it("uses the real clock when nothing is set", () => {
    const c = resolveClock([], {});
    expect(c.overridden).toBe(false);
    expect(Math.abs(c.now().getTime() - Date.now())).toBeLessThan(5000);
  });

  it("honours --now on the command line", () => {
    const c = resolveClock(["--now=2026-10-12T08:30:00-03:00"], {});
    expect(c.overridden).toBe(true);
    expect(c.now().toISOString()).toBe("2026-10-12T11:30:00.000Z");
  });

  it("honours DEMO_NOW env, with --now taking precedence", () => {
    expect(resolveClock([], { DEMO_NOW: "2026-01-01T00:00:00Z" }).now().toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(resolveClock(["--now=2026-02-02T00:00:00Z"], { DEMO_NOW: "2026-01-01T00:00:00Z" }).now().toISOString()).toBe("2026-02-02T00:00:00.000Z");
  });

  it("returns a fresh Date each call so callers cannot mutate the override", () => {
    const c = resolveClock(["--now=2026-10-12T08:30:00Z"], {});
    c.now().setFullYear(1999);
    expect(c.now().getUTCFullYear()).toBe(2026);
  });

  it("rejects garbage with a helpful message", () => {
    expect(() => resolveClock(["--now=next monday"], {})).toThrow(ClockError);
    expect(() => resolveClock(["--now=next monday"], {})).toThrow(/ISO 8601/);
  });
});

describe("timezone helpers", () => {
  it("converts UTC to Halifax wall clock (ADT in September is UTC-3)", () => {
    const p = partsInZone(new Date("2026-09-15T02:30:00Z"), "America/Halifax");
    expect(p).toMatchObject({ year: 2026, month: 9, day: 14, hour: 23, minute: 30, weekday: "monday" });
    expect(localDateString(new Date("2026-09-15T02:30:00Z"), "America/Halifax")).toBe("2026-09-14");
  });
});
