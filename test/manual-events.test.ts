/**
 * Events the curator adds by hand: storage, the fetcher that re-emits them every run, the dedupe
 * rules that keep them apart from each other and from the real calendar, and proof that a draft
 * containing one still passes the no-fabrication verifier.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveClock } from "../src/clock.js";
import type { Config, SourceConfig } from "../src/config.js";
import { validateConfig } from "../src/config.js";
import { buildDrafts } from "../src/draft/templates.js";
import { ManualEventsFetcher } from "../src/fetchers/manual.js";
import { itemFromManualEvent, validateManualEvent, type ManualEvent } from "../src/manual-events.js";
import { dedupeItems } from "../src/pipeline/dedupe.js";
import { validateItem } from "../src/schema.js";
import { SqliteStorage, StorageError } from "../src/storage.js";
import { sampleItem } from "./helpers.js";

const TZ = "America/Halifax";
const SOURCE: SourceConfig = { id: "manual-events", kind: "manual", type: "event", url: "", fallback_link: "https://voltaeffect.com/events", enabled: true };
const config = { timezone: TZ, events_window_days: 14, content_window_days: 7 } as Config;
const NOW = "2026-09-21T12:00:00Z";
const ctx = (storage: SqliteStorage) => ({ config, clock: resolveClock([`--now=${NOW}`], {}), storage });

let storage: SqliteStorage;
beforeEach(() => { storage = new SqliteStorage(":memory:"); });
afterEach(() => { storage.close(); });

describe("storing an event the curator added", () => {
  it("keeps what was typed, gives it an id, and reads it back inside the window", () => {
    const saved = storage.addManualEvent({ title: "  Demo   Night ", starts_at: "2026-09-25T22:00:00.000Z", location: "Volta, Halifax", description: "An evening of founder demos." });
    expect(saved.title).toBe("Demo Night");
    expect(saved.id).toMatch(/^me_/);
    const found = storage.listManualEvents(NOW, "2026-10-05T12:00:00Z");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ id: saved.id, title: "Demo Night", location: "Volta, Halifax", link: "" });
  });

  it("orders by start and excludes anything outside the range", () => {
    storage.addManualEvent({ title: "Later", starts_at: "2026-09-30T18:00:00.000Z" });
    storage.addManualEvent({ title: "Sooner", starts_at: "2026-09-23T18:00:00.000Z" });
    storage.addManualEvent({ title: "Way out", starts_at: "2026-12-01T18:00:00.000Z" });
    expect(storage.listManualEvents(NOW, "2026-10-05T12:00:00Z").map((e) => e.title)).toEqual(["Sooner", "Later"]);
  });

  it("refuses an invalid event rather than storing it", () => {
    expect(() => storage.addManualEvent({ title: "", starts_at: "2026-09-25T22:00:00.000Z" })).toThrow(StorageError);
    expect(() => storage.addManualEvent({ title: "No zone", starts_at: "2026-09-25T22:00:00" })).toThrow(StorageError);
    expect(storage.listManualEvents("2020-01-01T00:00:00Z", "2030-01-01T00:00:00Z")).toEqual([]);
  });

  it("adds its table to a database created before this feature existed", () => {
    const dir = mkdtempSync(join(tmpdir(), "volta-manual-"));
    const path = join(dir, "db.sqlite");
    try {
      const first = new SqliteStorage(path);
      first.upsertItems([sampleItem()]);
      first.close();
      const second = new SqliteStorage(path); // same file, reopened by the newer code
      const e = second.addManualEvent({ title: "Demo Night", starts_at: "2026-09-25T22:00:00.000Z" });
      expect(second.listManualEvents(NOW, "2026-10-05T12:00:00Z").map((x) => x.id)).toEqual([e.id]);
      expect(second.countItems()).toBe(1); // the existing rows are untouched
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("validating what the curator typed", () => {
  const ok = { title: "Demo Night", starts_at: "2026-09-25T22:00:00.000Z" };

  it("accepts a complete event and reports each problem against its own field", () => {
    expect(validateManualEvent(ok)).toEqual({});
    expect(validateManualEvent({ ...ok, title: "   " })).toHaveProperty("title");
    expect(validateManualEvent({ ...ok, starts_at: "next Tuesday" })).toHaveProperty("starts_at");
    expect(validateManualEvent({ ...ok, link: "voltaeffect.com/events" })).toHaveProperty("link");
    expect(validateManualEvent({ ...ok, title: "x".repeat(200) })).toHaveProperty("title");
  });

  it("allows a blank link but not a start in the past", () => {
    expect(validateManualEvent({ ...ok, link: "" })).toEqual({});
    expect(validateManualEvent({ ...ok, link: "https://voltaeffect.com/demo-night" })).toEqual({});
    expect(validateManualEvent(ok, new Date(NOW))).toEqual({});
    expect(validateManualEvent({ ...ok, starts_at: "2026-09-01T22:00:00.000Z" }, new Date(NOW))).toHaveProperty("starts_at");
  });
});

describe("the manual events fetcher", () => {
  it("emits schema-valid items every run, since the weekly cycle refetches", async () => {
    storage.addManualEvent({ title: "Demo Night", starts_at: "2026-09-25T22:00:00.000Z", location: "Volta, Halifax", description: "An evening of founder demos." });
    const r = await new ManualEventsFetcher().fetch(SOURCE, ctx(storage));
    expect(r.error).toBeUndefined();
    expect(r.items).toHaveLength(1);
    const item = r.items[0]!;
    expect(validateItem(item)).toEqual({ ok: true, errors: [] });
    expect(item).toMatchObject({ type: "event", title: "Demo Night", location: "Volta, Halifax", summary: "An evening of founder demos.", needs_summary: false, confidence: "medium" });
    expect(item.source_ref).toMatch(/^manual:me_/);
    expect(item.raw_excerpt).toBe("Demo Night Location: Volta, Halifax. An evening of founder demos.");
    // Re-running produces the same id, so storage upserts rather than duplicating.
    const again = await new ManualEventsFetcher().fetch(SOURCE, ctx(storage));
    expect(again.items[0]!.id).toBe(item.id);
  });

  it("falls back to the events page when the curator had no link, and says so", async () => {
    storage.addManualEvent({ title: "Demo Night", starts_at: "2026-09-25T22:00:00.000Z" });
    const r = await new ManualEventsFetcher().fetch(SOURCE, ctx(storage));
    expect(r.items[0]!.link).toBe("https://voltaeffect.com/events");
    expect(r.items[0]!.summary).toBe("");
    expect(r.items[0]!.needs_summary).toBe(true); // Bader is asked, nothing is invented
    expect(r.warnings.join(" ")).toContain("no link of its own");
  });

  it("keeps a real link when there is one, with no warning", async () => {
    storage.addManualEvent({ title: "Demo Night", starts_at: "2026-09-25T22:00:00.000Z", link: "https://voltaeffect.com/demo-night" });
    const r = await new ManualEventsFetcher().fetch(SOURCE, ctx(storage));
    expect(r.items[0]!.link).toBe("https://voltaeffect.com/demo-night");
    expect(r.warnings).toEqual([]);
  });

  it("shows only events between now and the end of the events window", async () => {
    storage.addManualEvent({ title: "Already happened", starts_at: "2026-09-10T22:00:00.000Z" });
    storage.addManualEvent({ title: "This week", starts_at: "2026-09-25T22:00:00.000Z" });
    storage.addManualEvent({ title: "Beyond the window", starts_at: "2026-11-30T22:00:00.000Z" });
    const r = await new ManualEventsFetcher().fetch(SOURCE, ctx(storage));
    expect(r.items.map((i) => i.title)).toEqual(["This week"]);
  });

  it("gives the same title on two dates two separate ids", async () => {
    storage.addManualEvent({ title: "Office Hours", starts_at: "2026-09-23T18:00:00.000Z" });
    storage.addManualEvent({ title: "Office Hours", starts_at: "2026-09-30T18:00:00.000Z" });
    const r = await new ManualEventsFetcher().fetch(SOURCE, ctx(storage));
    expect(new Set(r.items.map((i) => i.id)).size).toBe(2);
  });

  it("fails loudly rather than silently when it cannot do its job", async () => {
    const noStorage = await new ManualEventsFetcher().fetch(SOURCE, { config, clock: resolveClock([`--now=${NOW}`], {}) });
    expect(noStorage.error).toContain("no storage");
    const noFallback = await new ManualEventsFetcher().fetch({ id: SOURCE.id, kind: SOURCE.kind, type: SOURCE.type, url: "", enabled: true }, ctx(storage));
    expect(noFallback.error).toContain("fallback_link");
  });
});

describe("config for the manual source", () => {
  const base = { timezone: TZ, send_day: "monday", reminder_time: "08:30", content_window_days: 7, events_window_days: 14, watchlist: ["Volta"], holiday_overrides: [], alert_recipients: ["bader"] };

  it("requires a fallback page and needs no feed URL", () => {
    const good = validateConfig({ ...base, sources: [{ id: "manual-events", kind: "manual", type: "event", url: "", fallback_link: "https://voltaeffect.com/events", enabled: true }] });
    expect(good.sources[0]!.kind).toBe("manual");
    expect(() => validateConfig({ ...base, sources: [{ id: "manual-events", kind: "manual", type: "event", url: "", enabled: true }] })).toThrow(/fallback_link/);
  });
});

describe("dedupe treats hand-added events carefully", () => {
  const manual = (title: string, starts: string, id = "me_1"): ManualEvent =>
    ({ id, title, starts_at: starts, location: "Volta", description: `${title} at Volta.`, link: "", created_at: NOW });
  const asItem = (e: ManualEvent) => itemFromManualEvent(e, SOURCE, SOURCE.fallback_link!);

  it("never merges two different events that share the fallback link", () => {
    const a = asItem(manual("Demo Night", "2026-09-25T22:00:00.000Z", "me_1"));
    const b = asItem(manual("Investor Coffee", "2026-09-26T13:00:00.000Z", "me_2"));
    expect(a.link).toBe(b.link);
    const { items } = dedupeItems([a, b], TZ);
    expect(items).toHaveLength(2);
  });

  it("drops the hand-added copy once the real listing appears on the same day", () => {
    const added = asItem(manual("Demo Night", "2026-09-25T22:00:00.000Z"));
    const calendar = sampleItem({ type: "event", source: "volta-calendar", title: "Demo Night", date: "2026-09-25T22:00:00.000Z", link: "https://www.eventbrite.ca/e/demo-night", summary: "An evening of founder demos.", raw_excerpt: "Demo Night An evening of founder demos.", source_ref: "uid-demo" });
    const { items, merges } = dedupeItems([added, calendar], TZ);
    expect(items).toHaveLength(1);
    expect(items[0]!.source).toBe("volta-calendar");
    // Dropped, not folded: its link is only the generic events page.
    expect(items[0]!.related).toBeUndefined();
    expect(merges.join(" ")).toContain("added manually");
  });

  it("keeps both when the same title falls on different days", () => {
    const added = asItem(manual("Office Hours", "2026-09-23T18:00:00.000Z"));
    const calendar = sampleItem({ type: "event", source: "volta-calendar", title: "Office Hours", date: "2026-09-30T18:00:00.000Z", link: "https://www.eventbrite.ca/e/office-hours", raw_excerpt: "Office Hours at Volta." });
    expect(dedupeItems([added, calendar], TZ).items).toHaveLength(2);
  });

  it("leaves ordinary items deduping exactly as before", () => {
    const a = sampleItem({ link: "https://news.test/a?utm_source=x", title: "Volta launches a program" });
    const b = sampleItem({ link: "https://news.test/a", title: "Volta launches a program", source: "other" });
    expect(dedupeItems([a, b], TZ).items).toHaveLength(1);
  });
});

describe("a draft containing a hand-added event", () => {
  const draftFor = (e: ManualEvent) => buildDrafts([itemFromManualEvent(e, SOURCE, SOURCE.fallback_link!)], { timeZone: TZ })[1]!;

  it("passes the no-fabrication verifier, saying only what was typed", () => {
    const d = draftFor({ id: "me_1", title: "Demo Night", starts_at: "2026-09-25T22:00:00.000Z", location: "Volta, Halifax", description: "An evening of founder demos.", link: "", created_at: NOW });
    expect(d.verification.violations).toEqual([]);
    expect(d.markdown).toContain("When: Friday, September 25, 7:00 pm");
    expect(d.markdown).toContain("Where: Volta, Halifax");
    expect(d.markdown).toContain("https://voltaeffect.com/events");
  });

  it("still verifies for an event on the day the clocks change", () => {
    // 2026-11-01 is the end of daylight time in Halifax: 2pm ADT is 17:00Z, 2pm AST is 18:00Z.
    const d = draftFor({ id: "me_2", title: "November Meetup", starts_at: "2026-11-01T18:00:00.000Z", location: "Volta", description: "A meetup after the clocks change.", link: "", created_at: NOW });
    expect(d.verification.violations).toEqual([]);
    expect(d.markdown).toContain("When: Sunday, November 1, 2:00 pm");
  });
});
