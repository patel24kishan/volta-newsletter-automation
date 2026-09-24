import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage, StorageError } from "../src/storage.js";
import { sampleItem } from "./helpers.js";

describe("SqliteStorage", () => {
  let s: SqliteStorage;
  beforeEach(() => {
    s = new SqliteStorage(":memory:");
  });
  afterEach(() => s.close());

  it("forgets a hand-added event, and says so when there was none", () => {
    const e = s.addManualEvent({ title: "Open House", starts_at: "2026-10-20T20:00:00.000Z" });
    expect(s.listManualEvents("2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z").map((x) => x.id)).toEqual([e.id]);
    expect(s.deleteManualEvent(e.id)).toBe(true);
    expect(s.listManualEvents("2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z")).toEqual([]);
    // Removing it twice, or removing one that was never there, is not an error.
    expect(s.deleteManualEvent(e.id)).toBe(false);
    expect(s.deleteManualEvent("me_never")).toBe(false);
  });

  /**
   * Only ever called once the platform has said the campaign is not there. Before this existed, a
   * campaign deleted in Mailchimp stayed on record, approve went on trying to update an id that was
   * gone, and the month could never be approved again.
   */
  it("forgets a campaign the platform no longer has, leaving the others alone", () => {
    s.recordCampaign("camp_gone", "key1", "2026-09", "https://mc.test/1");
    s.recordCampaign("camp_kept", "key2", "2026-10", "https://mc.test/2");
    expect(s.forgetCampaign("camp_gone")).toBe(true);
    expect(s.listCampaigns().map((c) => c.id)).toEqual(["camp_kept"]);
    // Forgetting it twice, or one that was never recorded, is not an error.
    expect(s.forgetCampaign("camp_gone")).toBe(false);
    expect(s.forgetCampaign("never")).toBe(false);
  });

  it("clears every change made to one item, and leaves other items' alone", () => {
    s.setCuratorEdit("2026-09", "manual-events:a", "title", "His title", "2026-09-24T12:00:00.000Z");
    s.setCuratorEdit("2026-09", "manual-events:a", "summary", "His words", "2026-09-24T12:00:00.000Z");
    s.setCuratorEdit("2026-09", "manual-events:b", "summary", "Another item", "2026-09-24T12:00:00.000Z");
    expect(s.clearCuratorEdits("2026-09", "manual-events:a")).toBe(2);
    expect(s.listCuratorEdits("2026-09").map((e) => e.item_id)).toEqual(["manual-events:b"]);
    // Nothing to clear is not an error, and another period's edits are untouched.
    expect(s.clearCuratorEdits("2026-09", "manual-events:a")).toBe(0);
    expect(s.clearCuratorEdits("2026-10", "manual-events:b")).toBe(0);
    expect(s.listCuratorEdits("2026-09")).toHaveLength(1);
  });

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
