/**
 * E3: a newsletter changed after it was approved stays one campaign. Approving again updates the
 * period's draft campaign; once that campaign has been sent, changes are refused.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryAlerter } from "../src/alerts.js";
import type { Draft } from "../src/draft/templates.js";
import { rankItems } from "../src/pipeline/rank.js";
import { MailchimpPublisher } from "../src/publish/mailchimp.js";
import type { PublishedCampaign, Publisher } from "../src/publish/types.js";
import { approve, buildDraft, editItem, send, setSelection, startReview, type ReviewState } from "../src/review/review.js";
import { SqliteStorage } from "../src/storage.js";
import { loadCampaigns, loadReview, restoreSession } from "../src/surface/session.js";
import { sampleItem } from "./helpers.js";

const TZ = "America/Halifax";
const NOW = new Date("2026-10-01T11:30:00Z");

class FakeMail implements Publisher {
  readonly platform = "Mailchimp";
  created: Draft[] = [];
  updates: Array<{ id: string; draft: Draft }> = [];
  sent: string[] = [];
  failUpdate = false;
  async verify() { return { audienceName: "Test", memberCount: 2 }; }
  async publishDraft(d: Draft): Promise<PublishedCampaign> {
    this.created.push(d);
    return { id: `camp_${this.created.length}`, editUrl: `https://mc.test/edit?id=${this.created.length}`, platform: this.platform };
  }
  async updateDraft(id: string, draft: Draft) {
    if (this.failUpdate) throw new Error("Mailchimp is down");
    this.updates.push({ id, draft });
  }
  async send(id: string) { this.sent.push(id); }
}

const mixer = sampleItem({ type: "event", source: "volta-calendar", link: "https://e.test/mixer", title: "Fall Mixer", date: "2026-10-22T21:00:00Z", summary: "Meet the fall cohort.", raw_excerpt: "Fall Mixer Meet the fall cohort.", event_timing: "upcoming" });
const story = sampleItem({ link: "https://news.test/a", title: "Volta launches a program" });

let dir: string;
let storage: SqliteStorage;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "volta-e3-")); storage = new SqliteStorage(join(dir, "db.sqlite")); });
afterEach(() => { storage.close(); rmSync(dir, { recursive: true, force: true }); });

function review(mail: Publisher, period = "2026-10"): ReviewState {
  const st: ReviewState = {
    candidates: [], timeZone: TZ, outDir: dir, drafts: new Map(), selections: new Map(), env: { ALLOW_LIVE: "1" }, campaigns: new Set(),
    session: storage, edits: storage, week: period, layout: "events-first", cadence: "monthly", now: () => NOW,
    publisher: mail, audience: { audienceName: "Test", memberCount: 2 },
  };
  loadCampaigns(st, storage);
  const saved = loadReview(storage, period);
  if (saved && "snapshot" in saved) restoreSession(st, saved.snapshot);
  else startReview(st, { candidates: rankItems([mixer, story], NOW), preselectedIds: [mixer.id], period, firstWorkday: { date: "2026-10-01", weekday: "thursday", weekMonday: "2026-09-28", skipped: [] }, timeZone: TZ, clockLabel: "test", sourceNotes: [] });
  return st;
}
function built(st: ReviewState) {
  const r = buildDraft(st, new MemoryAlerter());
  if (!r.ok) throw new Error(`no draft: ${r.reason}`);
  return r;
}

describe("approving a changed newsletter", () => {
  it("updates the month's campaign in place instead of creating a second one", async () => {
    const mail = new FakeMail();
    const st = review(mail);
    const first = await approve(st, built(st).key);
    expect(first).toMatchObject({ status: "created", campaign: { id: "camp_1", editUrl: "https://mc.test/edit?id=1" } });

    setSelection(st, [mixer.id, story.id]);
    editItem(st, mixer.id, "summary", "Drinks, demos and the whole fall cohort.");
    const second = built(st);
    const again = await approve(st, second.key);
    expect(again).toMatchObject({ status: "updated", campaign: { id: "camp_1", editUrl: "https://mc.test/edit?id=1" } });
    expect(mail.created).toHaveLength(1);
    expect(mail.updates).toHaveLength(1);
    expect(mail.updates[0]!.id).toBe("camp_1");
    expect(mail.updates[0]!.draft.html).toContain("Drinks, demos and the whole fall cohort.");
    expect(mail.updates[0]!.draft.subject).toBe(second.draft.subject);
    expect(storage.listCampaigns().map((c) => c.id)).toEqual(["camp_1"]);

    // Approving that same version once more changes nothing.
    expect((await approve(st, second.key)).status).toBe("already");
    expect(mail.updates).toHaveLength(1);
  });

  it("still finds the month's campaign after a restart", async () => {
    const mail = new FakeMail();
    const st = review(mail);
    await approve(st, built(st).key);
    const after = review(mail); // a new chat: everything from storage
    setSelection(after, [story.id]);
    expect((await approve(after, built(after).key)).status).toBe("updated");
    expect(mail.created).toHaveLength(1);
  });

  it("refuses to change a month that was already sent, and touches nothing", async () => {
    const mail = new FakeMail();
    const st = review(mail);
    const a = await approve(st, built(st).key);
    if (a.status !== "created") throw new Error("expected a campaign");
    await send(st, a.campaign.id);
    setSelection(st, [story.id]);
    expect(await approve(st, built(st).key)).toMatchObject({ status: "period-sent", campaignId: "camp_1" });
    expect(mail.updates).toEqual([]);
    expect(mail.created).toHaveLength(1);
  });

  it("gives the next month its own campaign", async () => {
    const mail = new FakeMail();
    const oct = review(mail);
    await approve(oct, built(oct).key);
    const nov = review(mail, "2026-11");
    expect((await approve(nov, built(nov).key)).status).toBe("created");
    expect(storage.listCampaigns().map((c) => [c.id, c.period])).toEqual([["camp_1", "2026-10"], ["camp_2", "2026-11"]]);
  });

  it("reports a failed update without losing the draft or the campaign", async () => {
    const mail = new FakeMail();
    const st = review(mail);
    await approve(st, built(st).key);
    mail.failUpdate = true;
    setSelection(st, [story.id]);
    const r = await approve(st, built(st).key);
    expect(r).toMatchObject({ status: "failed", platform: "Mailchimp" });
    expect(storage.listCampaigns()).toHaveLength(1);
    mail.failUpdate = false;
    expect((await approve(st, [...st.drafts.keys()][0]!)).status).toBe("updated"); // retry works
  });

  it("never updates a campaign recorded before periods were kept", async () => {
    storage.recordCampaign("camp_old", "old-key"); // no period
    const mail = new FakeMail();
    const st = review(mail);
    expect((await approve(st, built(st).key)).status).toBe("created");
    expect(mail.updates).toEqual([]);
  });
});

describe("storage", () => {
  it("adds the period and edit link to a campaigns table made before them", () => {
    const old = join(dir, "old.sqlite");
    const db = new DatabaseSync(old);
    db.exec("CREATE TABLE campaigns (id TEXT PRIMARY KEY, draft_key TEXT NOT NULL, created_at TEXT NOT NULL, sent_at TEXT)");
    db.prepare("INSERT INTO campaigns VALUES ('camp_a', 'k', '2026-09-01T00:00:00Z', NULL)").run();
    db.close();
    const s = new SqliteStorage(old);
    try {
      expect(s.listCampaigns()).toEqual([{ id: "camp_a", draft_key: "k", created_at: "2026-09-01T00:00:00Z", sent_at: null, period: null, edit_url: null }]);
    } finally {
      s.close();
    }
  });
});

describe("Mailchimp", () => {
  it("updates a draft campaign's subject, then its content", async () => {
    const calls: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ method: init?.method ?? "GET", path: new URL(String(url)).pathname, body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response("{}", { status: 200 });
    }) as typeof globalThis.fetch;
    const mc = new MailchimpPublisher({ apiKey: "k-us21", listId: "L", fromName: "Volta", replyTo: "a@b.test", fetch });
    const draft = { id: "events-first", name: "Events first", subject: "Volta this month: Fall Mixer", html: "<p>new</p>" } as Draft;
    await mc.updateDraft("camp_1", draft);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["PATCH /3.0/campaigns/camp_1", "PUT /3.0/campaigns/camp_1/content"]);
    expect(calls[0]!.body).toMatchObject({ settings: { subject_line: "Volta this month: Fall Mixer", from_name: "Volta", reply_to: "a@b.test" } });
    expect(calls[1]!.body).toEqual({ html: "<p>new</p>" });
  });
});
