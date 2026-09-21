/**
 * Storage interface. Demo and local dev use SQLite via node:sqlite (no native build).
 * Production picks Firestore or D1 behind the same interface.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { validateManualEvent, type ManualEvent, type NewManualEvent } from "./manual-events.js";
import { EXTRA_FIELDS, validateItem, type Item, type RelatedLink } from "./schema.js";
import { collapseWhitespace } from "./text.js";

export interface Storage {
  /** Insert or replace items by id. Returns the number written. */
  upsertItems(items: Item[]): number;
  /** Items with date within [fromIso, toIso], ordered by date descending. */
  listItems(fromIso: string, toIso: string): Item[];
  getItem(id: string): Item | undefined;
  countItems(): number;
  /** Save an event the curator entered by hand. Throws StorageError if it is invalid. */
  addManualEvent(input: NewManualEvent): ManualEvent;
  /** Hand-added events starting within [fromIso, toIso], earliest first. */
  listManualEvents(fromIso: string, toIso: string): ManualEvent[];
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
        location TEXT,
        related TEXT,
        extra TEXT,
        fetched_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS items_date ON items(date);
      CREATE TABLE IF NOT EXISTS manual_events (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        starts_at TEXT NOT NULL,
        location TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        link TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS manual_events_start ON manual_events(starts_at);
    `);
    this.migrate();
  }

  /**
   * A database created by an earlier version lacks newer columns, and CREATE TABLE IF NOT EXISTS
   * leaves it that way. Add what is missing. Every addition is a nullable column, so this is safe
   * to run on every start and never touches existing rows.
   */
  private migrate(): void {
    const have = new Set((this.db.prepare("PRAGMA table_info(items)").all() as Array<{ name: string }>).map((c) => c.name));
    for (const [column, type] of [["location", "TEXT"], ["related", "TEXT"], ["extra", "TEXT"]] as const) {
      if (!have.has(column)) this.db.exec(`ALTER TABLE items ADD COLUMN ${column} ${type}`);
    }
  }

  upsertItems(items: Item[]): number {
    const stmt = this.db.prepare(`
      INSERT INTO items (id, source, type, date, title, summary, needs_summary, link, source_ref,
                         confidence, requires_review, raw_excerpt, location, related, extra, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        source=excluded.source, type=excluded.type, date=excluded.date, title=excluded.title,
        summary=excluded.summary, needs_summary=excluded.needs_summary, link=excluded.link,
        source_ref=excluded.source_ref, confidence=excluded.confidence,
        requires_review=excluded.requires_review, raw_excerpt=excluded.raw_excerpt,
        location=excluded.location, related=excluded.related, extra=excluded.extra,
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
          it.link, it.source_ref, it.confidence, it.requires_review ? 1 : 0, it.raw_excerpt, it.location ?? null,
          it.related && it.related.length ? JSON.stringify(it.related) : null, packExtra(it), now,
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
    // Normalize bounds to the same canonical form as stored dates (toISOString, with ms) so the
    // lexical comparison is exact at the boundaries.
    const from = new Date(fromIso).toISOString();
    const to = new Date(toIso).toISOString();
    const rows = this.db
      .prepare("SELECT * FROM items WHERE date >= ? AND date <= ? ORDER BY date DESC")
      .all(from, to) as Record<string, unknown>[];
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

  addManualEvent(input: NewManualEvent): ManualEvent {
    const errors = validateManualEvent(input);
    if (Object.keys(errors).length) throw new StorageError(`refusing to store invalid manual event: ${Object.values(errors).join(" ")}`);
    const event: ManualEvent = {
      id: `me_${randomUUID()}`,
      title: collapseWhitespace(input.title),
      // Canonical form (with ms) so the lexical comparison in listManualEvents is exact.
      starts_at: new Date(input.starts_at).toISOString(),
      location: collapseWhitespace(input.location ?? ""),
      description: collapseWhitespace(input.description ?? ""),
      link: (input.link ?? "").trim(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare("INSERT INTO manual_events (id, title, starts_at, location, description, link, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(event.id, event.title, event.starts_at, event.location, event.description, event.link, event.created_at);
    return event;
  }

  listManualEvents(fromIso: string, toIso: string): ManualEvent[] {
    const from = new Date(fromIso).toISOString();
    const to = new Date(toIso).toISOString();
    return this.db
      .prepare("SELECT id, title, starts_at, location, description, link, created_at FROM manual_events WHERE starts_at >= ? AND starts_at <= ? ORDER BY starts_at ASC")
      .all(from, to) as unknown as ManualEvent[];
  }

  close(): void {
    this.db.close();
  }
}

function rowToItem(r: Record<string, unknown>): Item {
  const item: Item = {
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
  if (typeof r.location === "string") item.location = r.location;
  if (typeof r.related === "string") item.related = JSON.parse(r.related) as RelatedLink[];
  if (typeof r.extra === "string") Object.assign(item, JSON.parse(r.extra) as Partial<Item>);
  return item;
}

/** The optional fields travel as one JSON column, so adding another never needs a migration. */
function packExtra(it: Item): string | null {
  const extra: Record<string, unknown> = {};
  for (const key of EXTRA_FIELDS) if (it[key] !== undefined) extra[key] = it[key];
  return Object.keys(extra).length ? JSON.stringify(extra) : null;
}
