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
