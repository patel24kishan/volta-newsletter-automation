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
  /** `period` ties the campaign to its month (or week), so a changed newsletter updates it instead of adding another. */
  recordCampaign(id: string, draftKey: string, period?: string, editUrl?: string): void;
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
  /**
   * A source the curator added himself. It lives here rather than in the config file, which is the
   * maintainer's and in production comes from a Google Sheet this process cannot write.
   * Throws StorageError if the id is already taken.
   */
  addCuratorSource(row: NewCuratorSource): CuratorSource;
  /** Every source the curator added, oldest first, enabled or not. */
  listCuratorSources(): CuratorSource[];
  /** Turn one off without losing it, or back on. False when there is no such source. */
  setCuratorSourceEnabled(id: string, enabled: boolean, nowIso: string): boolean;
  /** Forget a source. Items already fetched from it are left alone. False when there is no such source. */
  removeCuratorSource(id: string): boolean;
  /** Remember how a source last did, so the list can show it rather than looking healthy. */
  setCuratorSourceNote(id: string, note: string): boolean;
  close(): void;
}

/** A source the curator added, as stored. `terms` and `keywords` are lists, held as JSON. */
export interface CuratorSource {
  id: string;
  kind: string;
  type: string;
  url: string;
  terms: string[];
  channel_id: string;
  fallback_link: string;
  /** Empty means the newsletter's watchlist applies; see SourceConfig.keywords. */
  keywords: string[];
  /** Whether keywords were given at all: without this, "keep everything" and "use the watchlist" look alike. */
  filtered: boolean;
  /** The curator's name for it, shown in the source list and never printed in the newsletter. */
  label: string;
  /** How it last did, as one sentence for him ("could not be read: ..."). Empty until it is tried. */
  last_note: string;
  enabled: boolean;
  added_at: string;
}

export type NewCuratorSource = Omit<CuratorSource, "added_at" | "last_note"> & { added_at?: string; last_note?: string };

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
  /** The period it was approved for; null for campaigns recorded before this was kept. */
  period: string | null;
  /** Where the curator opens it in the platform's editor; null for older records. */
  edit_url: string | null;
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
        image TEXT NOT NULL DEFAULT '',
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
      CREATE TABLE IF NOT EXISTS curator_sources (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        type TEXT NOT NULL,
        url TEXT NOT NULL DEFAULT '',
        terms TEXT NOT NULL DEFAULT '[]',
        channel_id TEXT NOT NULL DEFAULT '',
        fallback_link TEXT NOT NULL DEFAULT '',
        keywords TEXT NOT NULL DEFAULT '[]',
        filtered INTEGER NOT NULL DEFAULT 0,
        label TEXT NOT NULL DEFAULT '',
        last_note TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL,
        added_at TEXT NOT NULL
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
    // Events added before images existed get an empty one.
    const manual = new Set((this.db.prepare("PRAGMA table_info(manual_events)").all() as Array<{ name: string }>).map((c) => c.name));
    const campaigns = new Set((this.db.prepare("PRAGMA table_info(campaigns)").all() as Array<{ name: string }>).map((c) => c.name));
    if (!campaigns.has("period")) this.db.exec("ALTER TABLE campaigns ADD COLUMN period TEXT");
    if (!campaigns.has("edit_url")) this.db.exec("ALTER TABLE campaigns ADD COLUMN edit_url TEXT");
    if (!manual.has("image")) this.db.exec("ALTER TABLE manual_events ADD COLUMN image TEXT NOT NULL DEFAULT ''");
    const sources = new Set((this.db.prepare("PRAGMA table_info(curator_sources)").all() as Array<{ name: string }>).map((c) => c.name));
    if (sources.size && !sources.has("last_note")) this.db.exec("ALTER TABLE curator_sources ADD COLUMN last_note TEXT NOT NULL DEFAULT ''");
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
      image: (input.image ?? "").trim(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare("INSERT INTO manual_events (id, title, starts_at, location, description, link, image, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(event.id, event.title, event.starts_at, event.location, event.description, event.link, event.image, event.created_at);
    return event;
  }

  listManualEvents(fromIso: string, toIso: string): ManualEvent[] {
    const from = new Date(fromIso).toISOString();
    const to = new Date(toIso).toISOString();
    return this.db
      .prepare("SELECT id, title, starts_at, location, description, link, image, created_at FROM manual_events WHERE starts_at >= ? AND starts_at <= ? ORDER BY starts_at ASC")
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

  recordCampaign(id: string, draftKey: string, period?: string, editUrl?: string): void {
    this.db
      .prepare("INSERT OR IGNORE INTO campaigns (id, draft_key, created_at, sent_at, period, edit_url) VALUES (?, ?, ?, NULL, ?, ?)")
      .run(id, draftKey, new Date().toISOString(), period ?? null, editUrl ?? null);
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

  addCuratorSource(row: NewCuratorSource): CuratorSource {
    if (this.db.prepare("SELECT 1 FROM curator_sources WHERE id = ?").get(row.id)) {
      throw new StorageError(`a source called ${row.id} already exists`);
    }
    const saved: CuratorSource = { ...row, last_note: row.last_note ?? "", added_at: row.added_at ?? new Date().toISOString() };
    this.db
      .prepare(`INSERT INTO curator_sources (id, kind, type, url, terms, channel_id, fallback_link, keywords, filtered, label, last_note, enabled, added_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(saved.id, saved.kind, saved.type, saved.url, JSON.stringify(saved.terms), saved.channel_id, saved.fallback_link,
        JSON.stringify(saved.keywords), saved.filtered ? 1 : 0, saved.label, saved.last_note, saved.enabled ? 1 : 0, saved.added_at);
    return saved;
  }

  listCuratorSources(): CuratorSource[] {
    const rows = this.db.prepare("SELECT * FROM curator_sources ORDER BY added_at ASC, id ASC").all() as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id), kind: String(r.kind), type: String(r.type), url: String(r.url),
      terms: parseList(r.terms), channel_id: String(r.channel_id), fallback_link: String(r.fallback_link),
      keywords: parseList(r.keywords), filtered: Number(r.filtered) === 1, label: String(r.label), last_note: String(r.last_note ?? ""),
      enabled: Number(r.enabled) === 1, added_at: String(r.added_at),
    }));
  }

  setCuratorSourceEnabled(id: string, enabled: boolean, _nowIso: string): boolean {
    const res = this.db.prepare("UPDATE curator_sources SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
    return Number(res.changes) > 0;
  }

  setCuratorSourceNote(id: string, note: string): boolean {
    const res = this.db.prepare("UPDATE curator_sources SET last_note = ? WHERE id = ?").run(note, id);
    return Number(res.changes) > 0;
  }

  removeCuratorSource(id: string): boolean {
    // Only the source goes; its items stay, so a newsletter already sent can still be traced back.
    const res = this.db.prepare("DELETE FROM curator_sources WHERE id = ?").run(id);
    return Number(res.changes) > 0;
  }

  listCuratorEdits(period: string): CuratorEdit[] {
    return this.db.prepare("SELECT period, item_id, field, value, edited_at FROM curator_edits WHERE period = ? ORDER BY edited_at ASC").all(period) as unknown as CuratorEdit[];
  }

  listCampaigns(): CampaignRecord[] {
    return this.db.prepare("SELECT id, draft_key, created_at, sent_at, period, edit_url FROM campaigns ORDER BY created_at ASC").all() as unknown as CampaignRecord[];
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

/** A JSON list column back as strings. A row written by hand, or corrupted, reads as empty. */
function parseList(value: unknown): string[] {
  if (typeof value !== "string" || value === "") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((t) => typeof t === "string") : [];
  } catch {
    return [];
  }
}
