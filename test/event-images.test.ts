/**
 * E2: an image on an event the curator adds. Checked when added, shown inline in the preview,
 * uploaded to the email platform at Approve so the email points at a hosted copy, and never part
 * of the text the verifier reads.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryAlerter } from "../src/alerts.js";
import type { SourceConfig } from "../src/config.js";
import type { Draft } from "../src/draft/templates.js";
import { buildDrafts } from "../src/draft/templates.js";
import { checkImage, MAX_IMAGE_BYTES } from "../src/images.js";
import { MailchimpPublisher } from "../src/publish/mailchimp.js";
import type { PublishedCampaign, Publisher } from "../src/publish/types.js";
import { addEvent, approve, buildDraft, editItem, startReview, type ReviewState } from "../src/review/review.js";
import { DryRunRefusal } from "../src/runtime.js";
import { SqliteStorage } from "../src/storage.js";
import { sampleItem } from "./helpers.js";

const TZ = "America/Halifax";
const NOW = new Date("2026-10-01T11:30:00Z");
const SOURCE = { id: "manual-events", kind: "manual", type: "event", url: "", fallback_link: "https://voltaeffect.com/events", enabled: true } as SourceConfig & { fallback_link: string };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46]);
const GIF = Buffer.from("GIF89a\x01\x00\x01\x00", "latin1");

let dir: string;
let storage: SqliteStorage;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "volta-img-")); storage = new SqliteStorage(join(dir, "db.sqlite")); });
afterEach(() => { storage.close(); rmSync(dir, { recursive: true, force: true }); });
const file = (name: string, bytes: Buffer) => { const p = join(dir, name); writeFileSync(p, bytes); return p; };

class FakeMail implements Publisher {
  readonly platform = "Mailchimp";
  uploads: string[] = [];
  published: Draft[] = [];
  async verify() { return { audienceName: "Test", memberCount: 2 }; }
  async uploadImage(f: { name: string; mime: string; bytes: Buffer }) { this.uploads.push(`${f.name}:${f.mime}`); return `https://mcusercontent.test/${f.name}`; }
  async publishDraft(d: Draft): Promise<PublishedCampaign> { this.published.push(d); return { id: "camp_1", editUrl: "https://mc.test/e", platform: this.platform }; }
  async send() { /* not used */ }
}

function review(o: { live?: boolean; mail?: Publisher } = {}): ReviewState {
  const st: ReviewState = {
    candidates: [], timeZone: TZ, outDir: dir, drafts: new Map(), selections: new Map(), env: { ALLOW_LIVE: o.live === false ? "0" : "1" },
    campaigns: new Set(), session: storage, edits: storage, storage, manualSource: SOURCE, week: "2026-10", layout: "events-first", cadence: "monthly", now: () => NOW,
    ...(o.mail ? { publisher: o.mail, audience: { audienceName: "Test", memberCount: 2 } } : {}),
  };
  startReview(st, { candidates: [], preselectedIds: [], period: "2026-10", firstWorkday: { date: "2026-10-01", weekday: "thursday", weekMonday: "2026-09-28", skipped: [] }, timeZone: TZ, clockLabel: "test", sourceNotes: [] });
  return st;
}
const EVENT = { title: "Demo Night", date: "2026-10-22", time: "19:00", location: "Volta, Halifax", description: "An evening of founder demos.", link: "" };

describe("checking an image", () => {
  it("accepts an https link, or a jpg, png or gif on this computer", () => {
    expect(checkImage(" https://cdn.test/poster.png ")).toEqual({ ref: "https://cdn.test/poster.png" });
    for (const [name, bytes] of [["a.png", PNG], ["b.jpg", JPG], ["c.JPEG", JPG], ["d.gif", GIF]] as const) {
      const p = file(name, bytes);
      expect(checkImage(p), name).toEqual({ ref: p });
      expect(checkImage(`"${p}"`), `${name} pasted in quotes`).toEqual({ ref: p });
    }
  });

  it("refuses what an email could not show, and says what to give instead", () => {
    expect(checkImage("http://cdn.test/a.png")).toEqual({ error: expect.stringMatching(/https:\/\//) });
    expect(checkImage("poster.png")).toEqual({ error: expect.stringMatching(/full path/) });
    expect(checkImage(join(dir, "missing.png"))).toEqual({ error: expect.stringMatching(/No file found/) });
    expect(checkImage(file("notes.txt", Buffer.from("hi")))).toEqual({ error: expect.stringMatching(/\.jpg, \.png or \.gif/) });
    expect(checkImage(file("fake.png", Buffer.from("not really a png")))).toEqual({ error: "fake.png does not look like a PNG image." });
    const big = file("big.png", Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]));
    expect(checkImage(big)).toEqual({ error: expect.stringMatching(/keep it under 5 MB/) });
    expect(checkImage("  ")).toEqual({ error: expect.stringMatching(/link to the image/) });
  });
});

describe("storing the image", () => {
  it("keeps it with the event", () => {
    storage.addManualEvent({ title: "Demo Night", starts_at: "2026-10-22T22:00:00.000Z", image: "https://cdn.test/p.png" });
    expect(storage.listManualEvents("2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z")[0]!.image).toBe("https://cdn.test/p.png");
  });

  it("adds the column to a database made before images existed", () => {
    const old = join(dir, "old.sqlite");
    const db = new DatabaseSync(old);
    db.exec("CREATE TABLE manual_events (id TEXT PRIMARY KEY, title TEXT NOT NULL, starts_at TEXT NOT NULL, location TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', link TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)");
    db.prepare("INSERT INTO manual_events VALUES ('me_1', 'Old one', '2026-10-05T22:00:00.000Z', '', '', '', '2026-09-01T00:00:00.000Z')").run();
    db.close();
    const s = new SqliteStorage(old);
    try {
      expect(s.listManualEvents("2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z")).toEqual([expect.objectContaining({ title: "Old one", image: "" })]);
    } finally {
      s.close();
    }
  });
});

describe("the image in the email", () => {
  const withImage = sampleItem({ type: "event", source: "manual-events", source_ref: "manual:me_1", link: "https://voltaeffect.com/events", title: "Demo Night", date: "2026-10-22T22:00:00Z", raw_excerpt: "Demo Night", summary: "", needs_summary: true, image: "https://cdn.test/poster.png", event_timing: "upcoming" });

  it("sits under the title with the title as its alt text, in HTML only, and the draft still verifies", () => {
    for (const d of buildDrafts([withImage], { timeZone: TZ, cadence: "monthly" })) {
      expect(d.html, d.id).toMatch(/<strong>Demo Night<\/strong><div style="margin-top:10px;"><img src="https:\/\/cdn\.test\/poster\.png" alt="Demo Night" width="500"/);
      expect(d.markdown, d.id).not.toContain("poster.png");
      expect(d.verification.ok, d.id).toBe(true);
    }
  });

  it("leaves out a local image unless told where to load it from", () => {
    const local = { ...withImage, image: "C:\\pics\\poster.png" };
    expect(buildDrafts([local], { timeZone: TZ, layouts: ["standard"] })[0]!.html).not.toContain("<img");
    expect(buildDrafts([local], { timeZone: TZ, layouts: ["standard"], imageSrc: () => "https://hosted.test/p.png" })[0]!.html).toContain('src="https://hosted.test/p.png"');
  });
});

describe("adding and approving an event with an image", () => {
  it("returns a plain error for a bad image and stores nothing", () => {
    const st = review();
    const r = addEvent(st, { ...EVENT, image: "poster.png" });
    expect(r).toEqual({ errors: { image: expect.stringMatching(/full path/) } });
    expect(storage.listManualEvents("2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z")).toEqual([]);
  });

  it("shows a local image inline in the preview, and uploads it once at Approve so the email uses the hosted copy", async () => {
    const mail = new FakeMail();
    const st = review({ mail });
    const poster = file("poster.png", PNG);
    const added = addEvent(st, { ...EVENT, image: poster });
    if (!("item" in added)) throw new Error("expected the event");
    const built = buildDraft(st, new MemoryAlerter());
    if (!built.ok) throw new Error("expected a draft");
    expect(built.draft.html).toContain('src="data:image/png;base64,');

    const a = await approve(st, built.key);
    expect(a.status).toBe("created");
    expect(mail.uploads).toEqual(["poster.png:image/png"]);
    expect(mail.published[0]!.html).toContain('src="https://mcusercontent.test/poster.png"');
    expect(mail.published[0]!.html).not.toContain("data:image");
    expect(mail.published[0]!.html).not.toContain(poster.replace(/\\/g, "\\\\"));
    expect(readFileSync(join(dir, "final.html"), "utf8")).toContain("https://mcusercontent.test/poster.png");
    expect((await approve(st, built.key)).status).toBe("already");
    expect(mail.uploads).toHaveLength(1);
  });

  it("uploads nothing in dry-run", async () => {
    const mail = new FakeMail();
    const st = review({ live: false, mail });
    addEvent(st, { ...EVENT, image: file("poster.png", PNG) });
    const built = buildDraft(st, new MemoryAlerter());
    if (!built.ok) throw new Error("expected a draft");
    await expect(approve(st, built.key)).rejects.toBeInstanceOf(DryRunRefusal);
    expect(mail.uploads).toEqual([]);
  });

  it("with no email platform, keeps the preview's inline image in the saved file", async () => {
    const st = review({ live: false });
    addEvent(st, { ...EVENT, image: file("poster.png", PNG) });
    const built = buildDraft(st, new MemoryAlerter());
    if (!built.ok) throw new Error("expected a draft");
    const a = await approve(st, built.key);
    expect(a.status).toBe("saved");
    expect(existsSync(join(dir, "final.html"))).toBe(true);
    expect(readFileSync(join(dir, "final.html"), "utf8")).toContain("data:image/png;base64,");
  });

  it("lets the curator retitle or change the image of an event they added", () => {
    const st = review();
    const added = addEvent(st, { ...EVENT, image: "https://cdn.test/a.png" });
    if (!("item" in added)) throw new Error("expected the event");
    expect(editItem(st, added.item.id, "title", "Founder Demo Night")).toHaveProperty("item.title", "Founder Demo Night");
    expect(editItem(st, added.item.id, "image", "https://cdn.test/b.png")).toHaveProperty("item.image", "https://cdn.test/b.png");
    expect(editItem(st, added.item.id, "image", "http://cdn.test/b.png")).toEqual({ error: expect.stringMatching(/https:\/\//) });
    const built = buildDraft(st, new MemoryAlerter());
    if (!built.ok) throw new Error("expected a draft");
    expect(built.draft.markdown).toContain("Founder Demo Night");
    expect(built.draft.html).toContain('src="https://cdn.test/b.png" alt="Founder Demo Night"');
  });
});

describe("Mailchimp image hosting", () => {
  it("uploads to the File Manager and returns the hosted address", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const fetch = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body ?? "") });
      return new Response(JSON.stringify({ full_size_url: "https://mcusercontent.com/abc/poster.png" }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const mc = new MailchimpPublisher({ apiKey: "k-us21", listId: "L", fromName: "Volta", replyTo: "a@b.test", fetch: fetch as typeof globalThis.fetch });
    const url = await mc.uploadImage({ name: "poster.png", mime: "image/png", bytes: PNG });
    expect(url).toBe("https://mcusercontent.com/abc/poster.png");
    expect(calls[0]!.url).toBe("https://us21.api.mailchimp.com/3.0/file-manager/files");
    expect(JSON.parse(calls[0]!.body)).toEqual({ name: "poster.png", file_data: PNG.toString("base64") });
  });
});
