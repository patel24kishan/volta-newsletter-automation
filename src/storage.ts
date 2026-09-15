/**
 * Storage interface. Demo and local dev use SQLite via node:sqlite (no native build).
 * Production picks Firestore or D1 behind the same interface.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { validateItem, type Item } from "./schema.js";

export interface Storage {
  /** Insert or replace items by id. Returns the number written. */
  upsertItems(items: Item[]): number;
  /** Items with date within [fromIso, toIso], ordered by date descending. */
  listItems(fromIso: string, toIso: string): Item[];
  getItem(id: string): Item | undefined;
  countItems(): number;
  close(): void;
}

export class StorageError extends Error {}

export class SqliteStorage implements Storage {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        type TEXT NOT NULL,
        date TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        needs_summary INTEGER NOT NULL,
        link TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        confidence TEXT NOT NULL,
        requires_review INTEGER NOT NULL,
        raw_excerpt TEXT NOT NULL,
        fetched_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS items_date ON items(date);
    `);
  }

  upsertItems(items: Item[]): number {
    const stmt = this.db.prepare(`
      INSERT INTO items (id, source, type, date, title, summary, needs_summary, link, source_ref,
                         confidence, requires_review, raw_excerpt, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        source=excluded.source, type=excluded.type, date=excluded.date, title=excluded.title,
        summary=excluded.summary, needs_summary=excluded.needs_summary, link=excluded.link,
        source_ref=excluded.source_ref, confidence=excluded.confidence,
        requires_review=excluded.requires_review, raw_excerpt=excluded.raw_excerpt,
        fetched_at=excluded.fetched_at
    `);
    const now = new Date().toISOString();
    let n = 0;
    this.db.exec("BEGIN");
    try {
      for (const it of items) {
        const v = validateItem(it);
        if (!v.ok) throw new StorageError(`refusing to store invalid item ${String(it.id)}: ${v.errors.join("; ")}`);
        stmt.run(
          it.id, it.source, it.type, it.date, it.title, it.summary, it.needs_summary ? 1 : 0,
          it.link, it.source_ref, it.confidence, it.requires_review ? 1 : 0, it.raw_excerpt, now,
        );
        n++;
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return n;
  }

  listItems(fromIso: string, toIso: string): Item[] {
    const rows = this.db
      .prepare("SELECT * FROM items WHERE date >= ? AND date <= ? ORDER BY date DESC")
      .all(fromIso, toIso) as Record<string, unknown>[];
    return rows.map(rowToItem);
  }

  getItem(id: string): Item | undefined {
    const row = this.db.prepare("SELECT * FROM items WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? rowToItem(row) : undefined;
  }

  countItems(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM items").get() as { n: number };
    return row.n;
  }

  close(): void {
    this.db.close();
  }
}

function rowToItem(r: Record<string, unknown>): Item {
  return {
    id: r.id as string,
    source: r.source as string,
    type: r.type as Item["type"],
    date: r.date as string,
    title: r.title as string,
    summary: r.summary as string,
    needs_summary: r.needs_summary === 1,
    link: r.link as string,
    source_ref: r.source_ref as string,
    confidence: r.confidence as Item["confidence"],
    requires_review: r.requires_review === 1,
    raw_excerpt: r.raw_excerpt as string,
  };
}
