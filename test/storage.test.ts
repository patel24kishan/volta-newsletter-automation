import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage, StorageError } from "../src/storage.js";
import { sampleItem } from "./helpers.js";

describe("SqliteStorage", () => {
  let s: SqliteStorage;
  beforeEach(() => {
    s = new SqliteStorage(":memory:");
  });
  afterEach(() => s.close());

  it("round-trips an item", () => {
    const it = sampleItem();
    expect(s.upsertItems([it])).toBe(1);
    expect(s.getItem(it.id)).toEqual(it);
  });

  it("upserting the same id twice keeps one row with the latest values", () => {
    const a = sampleItem({ title: "old" });
    const b = sampleItem({ title: "new" });
    s.upsertItems([a]);
    s.upsertItems([b]);
    expect(s.countItems()).toBe(1);
    expect(s.getItem(a.id)?.title).toBe("new");
  });

  it("lists items in a date window, newest first", () => {
    s.upsertItems([
      sampleItem({ link: "https://x/1", date: "2026-09-10T00:00:00Z" }),
      sampleItem({ link: "https://x/2", date: "2026-09-13T00:00:00Z" }),
      sampleItem({ link: "https://x/3", date: "2026-09-20T00:00:00Z" }),
    ]);
    const got = s.listItems("2026-09-09T00:00:00Z", "2026-09-15T00:00:00Z");
    expect(got.map((i) => i.link)).toEqual(["https://x/2", "https://x/1"]);
  });

  it("round-trips location and related links", () => {
    const it = sampleItem({ location: "Volta, Halifax", related: [{ source: "x", link: "https://x/1", title: "t" }] });
    s.upsertItems([it]);
    expect(s.getItem(it.id)).toEqual(it);
  });

  it("round-trips insights, editor notes, the hold note and the byline", () => {
    const it = sampleItem({ requires_review: true, hold_note: "REVISIT w/c Sep 28 (embargo)", byline: "Marc Comeau, co-founder", insights: ["one", "two"], editor_notes: ["Confirm before publishing."], message_link: "https://volta.slack.com/archives/C1/p1" });
    s.upsertItems([it]);
    expect(s.getItem(it.id)).toEqual(it);
    // An item without them comes back without them, not with empty placeholders.
    const plain = sampleItem({ link: "https://x/plain" });
    s.upsertItems([plain]);
    expect(s.getItem(plain.id)).toEqual(plain);
  });

  it("includes items stored at the exact window boundaries even when bounds omit milliseconds", () => {
    s.upsertItems([
      sampleItem({ link: "https://x/lo", date: "2026-09-10T00:00:00.000Z" }),
      sampleItem({ link: "https://x/hi", date: "2026-09-15T00:00:00.000Z" }),
    ]);
    const got = s.listItems("2026-09-10T00:00:00Z", "2026-09-15T00:00:00Z");
    expect(got.map((i) => i.link).sort()).toEqual(["https://x/hi", "https://x/lo"]);
  });

  it("refuses to store an invalid item and rolls back the whole batch", () => {
    const good = sampleItem({ link: "https://x/good" });
    const bad = sampleItem({ link: "not a url" });
    expect(() => s.upsertItems([good, bad])).toThrow(StorageError);
    expect(s.countItems()).toBe(0);
  });
});

describe("SqliteStorage migration", () => {
  it("opens a database created before the newer columns existed, adds them, and keeps the old rows", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { DatabaseSync } = await import("node:sqlite");
    const dir = mkdtempSync(join(tmpdir(), "volta-migrate-"));
    const path = join(dir, "old.sqlite");
    try {
      // The table exactly as the first version created it: no location, related or extra.
      const old = new DatabaseSync(path);
      old.exec(`CREATE TABLE items (id TEXT PRIMARY KEY, source TEXT NOT NULL, type TEXT NOT NULL, date TEXT NOT NULL,
        title TEXT NOT NULL, summary TEXT NOT NULL, needs_summary INTEGER NOT NULL, link TEXT NOT NULL, source_ref TEXT NOT NULL,
        confidence TEXT NOT NULL, requires_review INTEGER NOT NULL, raw_excerpt TEXT NOT NULL, fetched_at TEXT NOT NULL)`);
      old.prepare("INSERT INTO items VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run("old:1", "google-news", "news", "2026-09-01T00:00:00.000Z", "An old item", "s", 0, "https://x/old", "g", "high", 0, "An old item", "2026-09-01T00:00:00.000Z");
      old.close();

      const s = new SqliteStorage(path);
      expect(s.getItem("old:1")?.title).toBe("An old item");
      const fresh = sampleItem({ link: "https://x/new", insights: ["kept"], hold_note: "h", requires_review: true });
      expect(s.upsertItems([fresh])).toBe(1);
      expect(s.getItem(fresh.id)).toEqual(fresh);
      s.close();
      // Opening it again must not try to add the columns twice.
      const again = new SqliteStorage(path);
      expect(again.countItems()).toBe(2);
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("sources the curator added", () => {
  const row = (o: Record<string, unknown> = {}) => ({
    id: "cur_entrevestor", kind: "rss", type: "news", url: "https://entrevestor.test/feed", terms: [], channel_id: "",
    fallback_link: "", keywords: [], filtered: false, label: "Entrevestor", last_note: "", enabled: true, ...o,
  });

  it("round-trips one, keeping its lists and its on-off state", () => {
    const s = new SqliteStorage(":memory:");
    try {
      const saved = s.addCuratorSource(row({ terms: ["Halifax startups"], keywords: ["ocean", "tech"], filtered: true }));
      expect(saved.added_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(s.listCuratorSources()).toEqual([{ ...row({ terms: ["Halifax startups"], keywords: ["ocean", "tech"], filtered: true }), added_at: saved.added_at }]);
    } finally {
      s.close();
    }
  });

  it("refuses a second source with the same id", () => {
    const s = new SqliteStorage(":memory:");
    try {
      s.addCuratorSource(row());
      expect(() => s.addCuratorSource(row())).toThrow(StorageError);
      expect(() => s.addCuratorSource(row())).toThrow(/already exists/);
      expect(s.listCuratorSources()).toHaveLength(1);
    } finally {
      s.close();
    }
  });

  it("turns one off and on again, and says so when there is no such source", () => {
    const s = new SqliteStorage(":memory:");
    try {
      s.addCuratorSource(row());
      expect(s.setCuratorSourceEnabled("cur_entrevestor", false, "2026-09-23T12:00:00.000Z")).toBe(true);
      expect(s.listCuratorSources()[0]!.enabled).toBe(false);
      expect(s.setCuratorSourceEnabled("cur_entrevestor", true, "2026-09-23T12:00:00.000Z")).toBe(true);
      expect(s.listCuratorSources()[0]!.enabled).toBe(true);
      expect(s.setCuratorSourceEnabled("cur_nothing", false, "2026-09-23T12:00:00.000Z")).toBe(false);
    } finally {
      s.close();
    }
  });

  it("removes one without touching the items already fetched from it", () => {
    const s = new SqliteStorage(":memory:");
    try {
      s.addCuratorSource(row());
      const item = sampleItem({ source: "cur_entrevestor", link: "https://entrevestor.test/a" });
      s.upsertItems([item]);
      expect(s.removeCuratorSource("cur_entrevestor")).toBe(true);
      expect(s.listCuratorSources()).toEqual([]);
      expect(s.getItem(item.id)?.title).toBe(item.title);
      expect(s.removeCuratorSource("cur_entrevestor")).toBe(false);
    } finally {
      s.close();
    }
  });

  it("is empty, not broken, on a database made before sources could be added", () => {
    const s = new SqliteStorage(":memory:");
    try {
      expect(s.listCuratorSources()).toEqual([]);
    } finally {
      s.close();
    }
  });
});
