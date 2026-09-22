/**
 * The review with no chat surface: what Claude's tools will call. The Slack handlers are thin
 * wrappers over these, so their tests cover the same paths through Slack; these prove the core
 * on its own, and that it is safe in dry-run without reaching the email platform.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryAlerter } from "../src/alerts.js";
import type { SourceConfig } from "../src/config.js";
import { rankItems } from "../src/pipeline/rank.js";
import type { Publisher, PublishedCampaign } from "../src/publish/types.js";
import {
  addEvent, approve, buildDraft, CLAUDE_CHANNEL, currentDraft, currentSelection, send, setSelection, startReview, type ReviewState,
} from "../src/review/review.js";
import { DryRunRefusal } from "../src/runtime.js";
import { SqliteStorage } from "../src/storage.js";
import type { ReminderInput } from "../src/surface/blocks.js";
import { loadReview, restoreSession } from "../src/surface/session.js";
import { sampleItem } from "./helpers.js";

const TZ = "America/Halifax";
const NOW = new Date("2026-09-21T12:00:00Z");
const WEEK = "2026-09-21";
const SOURCE = { id: "manual-events", kind: "manual", type: "event", url: "", fallback_link: "https://voltaeffect.com/events", enabled: true } as SourceConfig & { fallback_link: string };

const yoga = sampleItem({ type: "event", source: "volta-calendar", link: "https://www.eventbrite.ca/e/yoga", title: "Yoga", date: "2026-09-24T15:00:00Z", summary: "Join us for a 1-hour guided yoga session.", raw_excerpt: "Yoga Join us for a 1-hour guided yoga session.", location: "Volta" });
const story = sampleItem({ link: "https://news.test/a", title: "Volta launches a program" });
const held = sampleItem({ link: "https://news.test/held", title: "Bellwether Soil", requires_review: true, hold_note: "Embargo, not editorial.", raw_excerpt: "Bellwether Soil news.", summary: "Bellwether Soil news." });
const candidates = rankItems([yoga, story, held], NOW);
const input: ReminderInput = {
  candidates, preselectedIds: [yoga.id, story.id], firstWorkday: { date: WEEK, weekday: "monday", weekMonday: WEEK, skipped: [] },
  timeZone: TZ, clockLabel: "test", sourceNotes: [],
};

class FakeMail implements Publisher {
  readonly platform = "Mailchimp";
  created = 0;
  sent: string[] = [];
  fail = false;
  async verify() { return { audienceName: "Test", memberCount: 2 }; }
  async publishDraft(): Promise<PublishedCampaign> {
    if (this.fail) throw new Error("Mailchimp is down");
    this.created++;
    return { id: `camp_${this.created}`, editUrl: "https://mc.test/e", platform: this.platform };
  }
  async send(id: string) { this.sent.push(id); }
}

let storage: SqliteStorage;
let outDir: string;
beforeEach(() => {
  storage = new SqliteStorage(":memory:");
  outDir = mkdtempSync(join(tmpdir(), "volta-review-"));
});
afterEach(() => {
  storage.close();
  rmSync(outDir, { recursive: true, force: true });
});

function state(o: { live?: boolean; mail?: Publisher } = {}): ReviewState {
  return {
    candidates: [], timeZone: TZ, outDir, drafts: new Map(), selections: new Map(),
    env: { ALLOW_LIVE: o.live === false ? "0" : "1" }, campaigns: new Set(), now: () => NOW,
    session: storage, week: WEEK, storage, manualSource: SOURCE, layout: "events-first",
    ...(o.mail ? { publisher: o.mail, audience: { audienceName: "Test", memberCount: 2 } } : {}),
  };
}

describe("the review core", () => {
  it("starts the week with the pre-ticked items selected, and saves it at once", () => {
    const st = state();
    startReview(st, input);
    expect(currentSelection(st)).toEqual([yoga.id, story.id]);
    expect(st.reminder!.channel).toBe(CLAUDE_CHANNEL);
    expect(loadReview(storage, WEEK)).toEqual({ snapshot: expect.objectContaining({ v: 1 }) });
  });

  it("keeps only real candidate ids in a selection, and says which were not", () => {
    const st = state();
    startReview(st, input);
    const r = setSelection(st, [story.id, "google-news:nope", story.id]);
    expect(r).toEqual({ selected: [story.id], unknown: ["google-news:nope"] });
    expect(currentSelection(st)).toEqual([story.id]);
  });

  it("builds and verifies a draft from the selection, with a preview and the notes the newsletter will not say", () => {
    const st = state();
    const pages: string[] = [];
    st.preview = { put: (html, id) => { pages.push(html); return `http://127.0.0.1:3111/p/${id}`; } };
    startReview(st, input);
    const r = buildDraft(st, new MemoryAlerter(), [yoga.id, held.id]);
    if (!r.ok) throw new Error("expected a draft");
    expect(r.draft.verification.ok).toBe(true);
    expect(r.draft.markdown).toContain("Yoga");
    expect(r.previewUrl).toMatch(/^http:\/\/127\.0\.0\.1:3111\/p\//);
    expect(pages).toHaveLength(1);
    expect(r.notes.held).toEqual([{ id: held.id, title: "Bellwether Soil", hold_note: "Embargo, not editorial." }]);
    expect(currentDraft(st)!.key).toBe(r.key);
  });

  it("refuses an empty selection, and ignores ids that are not candidates", () => {
    const st = state();
    startReview(st, input);
    expect(buildDraft(st, new MemoryAlerter(), [])).toMatchObject({ ok: false, reason: "nothing-selected" });
    expect(buildDraft(st, new MemoryAlerter(), ["google-news:nope"])).toMatchObject({ ok: false, reason: "nothing-selected" });
    expect(currentDraft(st)).toBeUndefined();
  });

  it("builds and saves drafts in dry-run, but will not create a campaign", async () => {
    const mail = new FakeMail();
    const st = state({ live: false, mail });
    startReview(st, input);
    const r = buildDraft(st, new MemoryAlerter());
    if (!r.ok) throw new Error("expected a draft");
    await expect(approve(st, r.key)).rejects.toBeInstanceOf(DryRunRefusal);
    expect(mail.created).toBe(0);
    await expect(send(st, "camp_1")).rejects.toBeInstanceOf(DryRunRefusal);
  });

  it("saves the approved newsletter locally when no email platform is configured", async () => {
    const st = state({ live: false });
    startReview(st, input);
    const r = buildDraft(st, new MemoryAlerter());
    if (!r.ok) throw new Error("expected a draft");
    const a = await approve(st, r.key);
    expect(a.status).toBe("saved");
    if (a.status === "saved") expect(existsSync(a.files.html)).toBe(true);
  });

  it("creates one campaign however often a draft is approved, and refuses an old key", async () => {
    const mail = new FakeMail();
    const st = state({ mail });
    startReview(st, input);
    const r = buildDraft(st, new MemoryAlerter());
    if (!r.ok) throw new Error("expected a draft");
    expect((await approve(st, r.key)).status).toBe("created");
    expect((await approve(st, r.key)).status).toBe("already");
    expect(mail.created).toBe(1);
    expect(storage.listCampaigns().map((c) => c.id)).toEqual(["camp_1"]);

    buildDraft(st, new MemoryAlerter(), [story.id]);
    expect(await approve(st, r.key)).toEqual({ status: "missing" });
  });

  it("reports a failed campaign creation without losing the saved file", async () => {
    const mail = new FakeMail();
    mail.fail = true;
    const st = state({ mail });
    startReview(st, input);
    const r = buildDraft(st, new MemoryAlerter());
    if (!r.ok) throw new Error("expected a draft");
    const a = await approve(st, r.key);
    expect(a).toMatchObject({ status: "failed", platform: "Mailchimp" });
    if (a.status === "failed") expect(existsSync(a.files.html)).toBe(true);
    expect(st.campaigns.size).toBe(0);
  });

  it("sends a campaign it created once, and refuses a repeat or one it did not create", async () => {
    const mail = new FakeMail();
    const st = state({ mail });
    startReview(st, input);
    const r = buildDraft(st, new MemoryAlerter());
    if (!r.ok) throw new Error("expected a draft");
    const a = await approve(st, r.key);
    if (a.status !== "created") throw new Error("expected a campaign");
    expect(await send(st, a.campaign.id)).toEqual({ status: "sent", platform: "Mailchimp" });
    expect(await send(st, a.campaign.id)).toEqual({ status: "already-sent" });
    expect(await send(st, "camp_elsewhere")).toEqual({ status: "unknown" });
    expect(mail.sent).toEqual([a.campaign.id]);
  });

  it("adds a curator's event already ticked, and returns field errors instead of guessing", () => {
    const st = state({ live: false }); // local storage only, so it works in dry-run
    startReview(st, input);
    const bad = addEvent(st, { title: "Demo Night", date: "2026-09-01", time: "19:00", location: "", description: "", link: "" });
    expect("errors" in bad && bad.errors.starts_at).toMatch(/future/);
    const ok = addEvent(st, { title: "Demo Night", date: "2026-09-25", time: "19:00", location: "Volta, Halifax", description: "An evening of founder demos.", link: "" });
    if (!("item" in ok)) throw new Error("expected an item");
    expect(currentSelection(st)).toContain(ok.item.id);
    expect(st.candidates.map((c) => c.item.id)).toContain(ok.item.id);
  });

  it("picks up where it was left after a restart: selection, draft and campaign", async () => {
    const mail = new FakeMail();
    const st = state({ mail });
    startReview(st, input);
    setSelection(st, [story.id]);
    const r = buildDraft(st, new MemoryAlerter());
    if (!r.ok) throw new Error("expected a draft");
    await approve(st, r.key);

    const again = state({ mail });
    const saved = loadReview(storage, WEEK);
    if (!saved || !("snapshot" in saved)) throw new Error("expected a saved review");
    restoreSession(again, saved.snapshot);
    expect(currentSelection(again)).toEqual([story.id]);
    expect((await approve(again, r.key)).status).toBe("already");
    expect(mail.created).toBe(1);
  });
});
