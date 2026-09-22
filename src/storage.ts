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
  /** The week's Slack session as saved, raw; session.ts owns its shape and checks it. */
  loadSession(week: string): string | undefined;
  saveSession(week: string, state: string): void;
  /** A campaign Approve created. Recording it twice is harmless. */
  recordCampaign(id: string, draftKey: string): void;
  markCampaignSent(id: string): void;
  listCampaigns(): CampaignRecord[];
  /**
   * Take the right to do `task` for `period` (a week). Atomic, so of two processes asking at once
   * only one gets it. A claim older than `ttlMs` that was never completed can be taken over, so a
   * process that died mid-task does not block the task forever.
   */
  claimMark(task: string, period: string, nowIso: string, ttlMs: number): boolean;
  /** Give a claim back, so the task can be tried again. */
  releaseMark(task: string, period: string): void;
  completeMark(task: string, period: string, nowIso: string): void;
  getMark(task: string, period: string): ScheduleMark | undefined;
  /** Keep work for `task` so a retry, even after a restart, need not repeat it. */
  setMarkPayload(task: string, period: string, payload: string): void;
  /**
   * The curator's own wording for one field of one item, for a period. Kept apart from the items,
   * which are never overwritten, so a re-fetch cannot lose it. `null` removes it.
   */
  setCuratorEdit(period: string, itemId: string, field: string, value: string | null, nowIso: string): void;
  listCuratorEdits(period: string): CuratorEdit[];
  close(): void;
}

export interface CuratorEdit {
  period: string;
  item_id: string;
  field: string;
  value: string;
  edited_at: string;
}

export interface ScheduleMark {
  task: string;
  period: string;
  claimed_at: string | null;
  done_at: string | null;
  payload: string | null;
}

/**
 * Deliberately not tied to a week: a campaign approved on a Friday is still sendable after a
 * Monday restart, and one already sent can never be sent again from Slack.
 */
export interface CampaignRecord {
  id: string;
  draft_key: string;
  created_at: string;
  sent_at: string | null;
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
      CREATE TABLE IF NOT EXISTS slack_sessions (
        week TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS campaigns (
        id TEXT PRIMARY KEY,
        draft_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        sent_at TEXT
      );
      CREATE TABLE IF NOT EXISTS schedule_marks (
        task TEXT NOT NULL,
        period TEXT NOT NULL,
        claimed_at TEXT,
        done_at TEXT,
        payload TEXT,
        PRIMARY KEY (task, period)
      );
      CREATE TABLE IF NOT EXISTS curator_edits (
        period TEXT NOT NULL,
        item_id TEXT NOT NULL,
        field TEXT NOT NULL,
        value TEXT NOT NULL,
        edited_at TEXT NOT NULL,
        PRIMARY KEY (period, item_id, field)
      );
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

  loadSession(week: string): string | undefined {
    const row = this.db.prepare("SELECT state FROM slack_sessions WHERE week = ?").get(week) as { state: string } | undefined;
    return row?.state;
  }

  saveSession(week: string, state: string): void {
    this.db
      .prepare("INSERT INTO slack_sessions (week, state, updated_at) VALUES (?, ?, ?) ON CONFLICT(week) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at")
      .run(week, state, new Date().toISOString());
  }

  recordCampaign(id: string, draftKey: string): void {
    this.db
      .prepare("INSERT OR IGNORE INTO campaigns (id, draft_key, created_at, sent_at) VALUES (?, ?, ?, NULL)")
      .run(id, draftKey, new Date().toISOString());
  }

  markCampaignSent(id: string): void {
    this.db.prepare("UPDATE campaigns SET sent_at = ? WHERE id = ? AND sent_at IS NULL").run(new Date().toISOString(), id);
  }

  setCuratorEdit(period: string, itemId: string, field: string, value: string | null, nowIso: string): void {
    if (value === null) {
      this.db.prepare("DELETE FROM curator_edits WHERE period = ? AND item_id = ? AND field = ?").run(period, itemId, field);
      return;
    }
    this.db
      .prepare("INSERT INTO curator_edits (period, item_id, field, value, edited_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(period, item_id, field) DO UPDATE SET value = excluded.value, edited_at = excluded.edited_at")
      .run(period, itemId, field, value, nowIso);
  }

  listCuratorEdits(period: string): CuratorEdit[] {
    return this.db.prepare("SELECT period, item_id, field, value, edited_at FROM curator_edits WHERE period = ? ORDER BY edited_at ASC").all(period) as unknown as CuratorEdit[];
  }

  listCampaigns(): CampaignRecord[] {
    return this.db.prepare("SELECT id, draft_key, created_at, sent_at FROM campaigns ORDER BY created_at ASC").all() as unknown as CampaignRecord[];
  }

  claimMark(task: string, period: string, nowIso: string, ttlMs: number): boolean {
    // A fresh row is ours outright. An existing one is ours only if unclaimed or its claim has
    // gone stale, and it was never completed. Each statement is atomic in SQLite.
    const inserted = this.db
      .prepare("INSERT OR IGNORE INTO schedule_marks (task, period, claimed_at) VALUES (?, ?, ?)")
      .run(task, period, nowIso);
    if (Number(inserted.changes) > 0) return true;
    const staleBefore = new Date(new Date(nowIso).getTime() - ttlMs).toISOString();
    const taken = this.db
      .prepare("UPDATE schedule_marks SET claimed_at = ? WHERE task = ? AND period = ? AND done_at IS NULL AND (claimed_at IS NULL OR claimed_at < ?)")
      .run(nowIso, task, period, staleBefore);
    return Number(taken.changes) > 0;
  }

  releaseMark(task: string, period: string): void {
    this.db.prepare("UPDATE schedule_marks SET claimed_at = NULL WHERE task = ? AND period = ? AND done_at IS NULL").run(task, period);
  }

  completeMark(task: string, period: string, nowIso: string): void {
    this.db
      .prepare("INSERT INTO schedule_marks (task, period, done_at) VALUES (?, ?, ?) ON CONFLICT(task, period) DO UPDATE SET done_at = excluded.done_at")
      .run(task, period, nowIso);
  }

  getMark(task: string, period: string): ScheduleMark | undefined {
    return this.db.prepare("SELECT task, period, claimed_at, done_at, payload FROM schedule_marks WHERE task = ? AND period = ?").get(task, period) as ScheduleMark | undefined;
  }

  setMarkPayload(task: string, period: string, payload: string): void {
    this.db
      .prepare("INSERT INTO schedule_marks (task, period, payload) VALUES (?, ?, ?) ON CONFLICT(task, period) DO UPDATE SET payload = excluded.payload")
      .run(task, period, payload);
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
