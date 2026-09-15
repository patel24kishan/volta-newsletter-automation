import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { resolveClock } from "../src/clock.js";
import type { Config, SourceConfig } from "../src/config.js";
import { IcsFetcher, parseIcs, parseIcsDate, parseProperty, unfold, zonedToUtc } from "../src/fetchers/ics.js";
import { validateItem } from "../src/schema.js";
import { firstSentences } from "../src/text.js";

const source: SourceConfig = { id: "volta-calendar", kind: "ics", type: "event", url: "https://example.test/cal.ics", enabled: true, fallback_link: "https://voltaeffect.com/events" };

function cfg(overrides: Partial<Config> = {}): Config {
  return {
    timezone: "America/Halifax", send_day: "monday", reminder_time: "08:30", content_window_days: 7, events_window_days: 14,
    watchlist: ["Volta"], holiday_overrides: [], alert_recipients: [], sources: [source], ...overrides,
  };
}

const CRLF = "\r\n";
function cal(events: string): string {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//", "X-WR-CALNAME:Volta", events, "END:VCALENDAR"].join(CRLF) + CRLF;
}
function ev(o: { uid: string; summary: string; start: string; end?: string; url?: string; desc?: string; loc?: string; status?: string }): string {
  return [
    "BEGIN:VEVENT", `UID:${o.uid}`, `SUMMARY:${o.summary}`, `DTSTART:${o.start}`, `DTEND:${o.end ?? o.start}`,
    o.url ? `URL:${o.url}` : "", o.desc ? `DESCRIPTION:${o.desc}` : "", o.loc ? `LOCATION:${o.loc}` : "", o.status ? `STATUS:${o.status}` : "",
    "END:VEVENT",
  ].filter(Boolean).join(CRLF);
}

const clock = resolveClock(["--now=2026-09-15T12:00:00Z"], {});
const fetcher = new IcsFetcher();

describe("ICS primitives", () => {
  it("unfolds CRLF+space and LF+tab continuations", () => {
    expect(unfold("A:one\r\n two\r\nB:x\n\tyz\n")).toEqual(["A:onetwo", "B:xyz", ""]);
  });

  it("parses params and unescapes text, ignoring colons inside quoted params", () => {
    const p = parseProperty('DTSTART;TZID="America/Halifax":20260916T180000')!;
    expect(p).toMatchObject({ name: "DTSTART", params: { TZID: "America/Halifax" }, value: "20260916T180000" });
    expect(parseProperty("DESCRIPTION:a\\, b\\; c\\nd")!.value).toBe("a, b; c\nd");
  });

  it("parses UTC, zoned, floating and all-day dates", () => {
    const tz = "America/Halifax";
    expect(parseIcsDate({ name: "DTSTART", params: {}, value: "20260916T210000Z" }, tz)!.toISOString()).toBe("2026-09-16T21:00:00.000Z");
    // 18:00 Halifax in September (ADT, UTC-3) is 21:00Z
    expect(parseIcsDate({ name: "DTSTART", params: { TZID: tz }, value: "20260916T180000" }, tz)!.toISOString()).toBe("2026-09-16T21:00:00.000Z");
    // a different, known TZID is honoured: 18:00 Toronto (EDT, UTC-4) is 22:00Z
    expect(parseIcsDate({ name: "DTSTART", params: { TZID: "America/Toronto" }, value: "20260916T180000" }, tz)!.toISOString()).toBe("2026-09-16T22:00:00.000Z");
    // an unknown TZID falls back to the configured zone
    expect(parseIcsDate({ name: "DTSTART", params: { TZID: "Mars/Olympus" }, value: "20260916T180000" }, tz)!.toISOString()).toBe("2026-09-16T21:00:00.000Z");
    expect(parseIcsDate({ name: "DTSTART", params: {}, value: "20260916T180000" }, tz)!.toISOString()).toBe("2026-09-16T21:00:00.000Z");
    // all-day: local midnight; in January (AST, UTC-4) that is 04:00Z
    expect(parseIcsDate({ name: "DTSTART", params: { VALUE: "DATE" }, value: "20260115" }, tz)!.toISOString()).toBe("2026-01-15T04:00:00.000Z");
    expect(parseIcsDate({ name: "DTSTART", params: {}, value: "16/09/2026" }, tz)).toBeUndefined();
  });

  it("zonedToUtc handles the DST boundary", () => {
    expect(zonedToUtc(2026, 3, 8, 12, 0, 0, "America/Halifax").toISOString()).toBe("2026-03-08T15:00:00.000Z");
    expect(zonedToUtc(2026, 3, 7, 12, 0, 0, "America/Halifax").toISOString()).toBe("2026-03-07T16:00:00.000Z");
  });

  it("firstSentences extracts and truncates at a word boundary", () => {
    expect(firstSentences("One. Two two. Three.", 2, 100)).toBe("One. Two two.");
    expect(firstSentences("", 2, 100)).toBe("");
    const long = firstSentences("word ".repeat(100), 1, 40);
    expect(long.length).toBeLessThanOrEqual(41);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("IcsFetcher on synthetic calendars", () => {
  it("keeps upcoming events in the window, sorted by start, as valid items with location", async () => {
    const body = cal(
      ev({ uid: "b", summary: "Vibe Coding Meetup", start: "20260921T210000Z", url: "https://voltaeffect.com/e/vibe", desc: "Bring a laptop. Build something\\, share it.", loc: "Volta\\, Halifax" }) + CRLF +
      ev({ uid: "a", summary: "AI Showcase", start: "20260916T210000Z", url: "https://voltaeffect.com/e/ai", desc: "Demos from local founders." }),
    );
    const r = await fetcher.fetch(source, { config: cfg(), clock, fetchText: async () => body });
    expect(r.error).toBeUndefined();
    expect(r.items.map((i) => i.title)).toEqual(["AI Showcase", "Vibe Coding Meetup"]);
    for (const i of r.items) expect(validateItem(i)).toEqual({ ok: true, errors: [] });
    expect(r.items[1]).toMatchObject({ location: "Volta, Halifax", summary: "Bring a laptop. Build something, share it.", needs_summary: false, confidence: "high", source_ref: "b" });
  });

  it("drops past events and events beyond the look-ahead window; the clock override moves the window", async () => {
    const body = cal(
      ev({ uid: "p", summary: "Past", start: "20260910T210000Z", url: "https://x.test/p" }) + CRLF +
      ev({ uid: "f", summary: "Far", start: "20261101T210000Z", url: "https://x.test/f" }) + CRLF +
      ev({ uid: "n", summary: "Near", start: "20260920T210000Z", url: "https://x.test/n" }),
    );
    const r = await fetcher.fetch(source, { config: cfg(), clock, fetchText: async () => body });
    expect(r.items.map((i) => i.title)).toEqual(["Near"]);
    expect(r.warnings.join("\n")).toMatch(/2 event\(s\) outside the next 14 days/);

    const oct = resolveClock(["--now=2026-10-25T12:00:00Z"], {});
    const r2 = await fetcher.fetch(source, { config: cfg(), clock: oct, fetchText: async () => body });
    expect(r2.items.map((i) => i.title)).toEqual(["Far"]);
  });

  it("keeps an event that started earlier but has not ended (in progress or multi-day)", async () => {
    const body = cal(
      ev({ uid: "m", summary: "Two-day summit", start: "20260914T120000Z", end: "20260916T200000Z", url: "https://x.test/m" }) + CRLF +
      ev({ uid: "o", summary: "Over", start: "20260915T080000Z", end: "20260915T090000Z", url: "https://x.test/o" }),
    );
    const r = await fetcher.fetch(source, { config: cfg(), clock, fetchText: async () => body });
    expect(r.items.map((i) => i.title)).toEqual(["Two-day summit"]);
  });

  it("warns when a TZID is unknown to Intl", async () => {
    const body = cal(["BEGIN:VEVENT", "UID:z", "SUMMARY:Odd zone", "DTSTART;TZID=Mars/Olympus:20260920T180000", "URL:https://x.test/z", "END:VEVENT"].join(CRLF));
    const r = await fetcher.fetch(source, { config: cfg(), clock, fetchText: async () => body });
    expect(r.items).toHaveLength(1);
    expect(r.warnings.join()).toMatch(/unknown TZID "Mars\/Olympus"/);
  });

  it("drops cancelled events", async () => {
    const body = cal(ev({ uid: "c", summary: "Cancelled thing", start: "20260920T210000Z", url: "https://x.test/c", status: "CANCELLED" }));
    const r = await fetcher.fetch(source, { config: cfg(), clock, fetchText: async () => body });
    expect(r.items).toHaveLength(0);
    expect(r.warnings.join()).toMatch(/1 cancelled/);
  });

  it("uses the fallback link with medium confidence when an event has no URL, and skips when there is no fallback", async () => {
    const body = cal(ev({ uid: "u", summary: "No link event", start: "20260920T210000Z" }));
    const r = await fetcher.fetch(source, { config: cfg(), clock, fetchText: async () => body });
    expect(r.items[0]).toMatchObject({ link: "https://voltaeffect.com/events", confidence: "medium" });

    const noFallback: SourceConfig = { ...source };
    delete noFallback.fallback_link;
    const r2 = await fetcher.fetch(noFallback, { config: cfg(), clock, fetchText: async () => body });
    expect(r2.items).toHaveLength(0);
    expect(r2.warnings.join()).toMatch(/no fallback_link/);
  });

  it("flags needs_summary when the event has no description", async () => {
    const body = cal(ev({ uid: "d", summary: "Bare", start: "20260920T210000Z", url: "https://x.test/d" }));
    const r = await fetcher.fetch(source, { config: cfg(), clock, fetchText: async () => body });
    expect(r.items[0]).toMatchObject({ summary: "", needs_summary: true });
  });

  it("reports fetch failures and non-calendar bodies as errors", async () => {
    expect((await fetcher.fetch(source, { config: cfg(), clock, fetchText: async () => { throw new Error("timed out"); } })).error).toMatch(/timed out/);
    expect((await fetcher.fetch(source, { config: cfg(), clock, fetchText: async () => "<html>nope</html>" })).error).toMatch(/not an iCalendar/);
    expect((await fetcher.fetch(source, { config: cfg(), clock, fetchText: async () => "" })).error).toMatch(/empty/);
  });
});

describe("recorded Volta calendar snapshot (test/fixtures/volta-calendar.ics)", () => {
  it("parses 72 events and, as of 15 Sep 2026, yields the September events the site lists", async () => {
    const body = await readFile("test/fixtures/volta-calendar.ics", "utf8");
    const parsed = parseIcs(body);
    expect("error" in parsed).toBe(false);
    if ("error" in parsed) return;
    expect(parsed.events).toHaveLength(72);

    const r = await fetcher.fetch(source, { config: cfg(), clock, fetchText: async () => body });
    expect(r.error).toBeUndefined();
    expect(r.items.length).toBeGreaterThanOrEqual(2);
    const titles = r.items.map((i) => i.title);
    expect(titles.some((t) => /AI Showcase/i.test(t))).toBe(true);
    expect(titles.some((t) => /Vibe Coding/i.test(t))).toBe(true);
    for (const i of r.items) {
      expect(validateItem(i).ok).toBe(true);
      expect(i.date >= "2026-09-15T12:00:00.000Z").toBe(true);
      expect(i.date <= "2026-09-29T12:00:00.000Z").toBe(true);
    }
  });
});
