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
import type { CampaignState, PublishedCampaign, Publisher } from "../src/publish/types.js";
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

/**
 * The record of what the platform holds can be wrong in both directions, and both were met in one
 * live run: a campaign deleted in Mailchimp, which left the month permanently unapprovable, and a
 * campaign sent from Mailchimp's own editor while this side still believed it was a draft. So the
 * decision to update, to refuse or to create is taken from what the platform says now.
 */
describe("when the platform and the record disagree", () => {
  /** A publisher that answers about its campaigns, the way Mailchimp's GET /campaigns/{id} does. */
  class Knowing extends FakeMail {
    state: CampaignState = "draft";
    asked: string[] = [];
    stateThrows = false;
    goneOnUpdate = false;
    override async updateDraft(id: string, draft: Draft) {
      if (this.goneOnUpdate) throw Object.assign(new Error("Mailchimp update campaign failed (HTTP 404): Resource Not Found"), { status: 404 });
      await super.updateDraft(id, draft);
    }
    async campaignState(id: string): Promise<CampaignState> {
      this.asked.push(id);
      if (this.stateThrows) throw new Error("Mailchimp is unreachable");
      return this.state;
    }
  }

  /** Approve, let something change on the platform, then come back to it as a fresh session would. */
  const approveTwice = async (mail: Knowing, between: (mail: Knowing) => void) => {
    const before = review(mail);
    const first = await approve(before, built(before).key);
    between(mail);
    const st = review(mail);
    return { first, second: await approve(st, built(st).key), st };
  };

  it("creates a fresh campaign when the earlier one was deleted, instead of failing for good", async () => {
    const mail = new Knowing();
    const { first, second } = await approveTwice(mail, (m) => { m.state = "missing"; });
    expect(first).toMatchObject({ status: "created", campaign: { id: "camp_1" } });
    // The whole point: the month is approvable again, under a new campaign.
    expect(second).toMatchObject({ status: "created", campaign: { id: "camp_2" } });
    expect(mail.updates, "nothing should be sent to a campaign that is gone").toEqual([]);
    // And the dead record is gone, so it cannot be picked again after a restart.
    expect(storage.listCampaigns().map((c) => c.id)).toEqual(["camp_2"]);
  });

  it("refuses when the platform says it has gone out, even though the record said otherwise", async () => {
    const mail = new Knowing();
    const { first, second } = await approveTwice(mail, (m) => { m.state = "sent"; });
    expect(first.status).toBe("created");
    expect(second).toMatchObject({ status: "period-sent", campaignId: "camp_1" });
    expect(mail.updates, "a newsletter subscribers have must never be rewritten").toEqual([]);
    // Written down, so the refusal holds next time even if the platform cannot be reached then.
    expect(storage.listCampaigns()[0]!.sent_at).not.toBeNull();
  });

  it("updates in place, as before, when the platform still holds a draft", async () => {
    const mail = new Knowing();
    const { first, second } = await approveTwice(mail, () => {});
    expect(first.status).toBe("created");
    expect(second).toMatchObject({ status: "updated", campaign: { id: "camp_1" } });
    expect(mail.asked).toEqual(["camp_1"]);
    expect(mail.created).toHaveLength(1);
  });

  it("never turns a passing fault into a second campaign for the month", async () => {
    const mail = new Knowing();
    const { second } = await approveTwice(mail, (m) => { m.failUpdate = true; });
    expect(second.status).toBe("failed");
    expect(mail.created, "one bad minute must not leave two campaigns behind").toHaveLength(1);
    expect(storage.listCampaigns().map((c) => c.id)).toEqual(["camp_1"]);
  });

  it("falls back to what it recorded when the platform cannot be asked", async () => {
    const mail = new Knowing();
    const { second } = await approveTwice(mail, (m) => { m.stateThrows = true; });
    // Unreachable is not the same as gone: it behaves as it always did rather than guessing.
    expect(second).toMatchObject({ status: "updated", campaign: { id: "camp_1" } });
    expect(mail.created).toHaveLength(1);
  });

  it("still recovers when the campaign is deleted between the question and the answer", async () => {
    const mail = new Knowing();
    const { second } = await approveTwice(mail, (m) => { m.goneOnUpdate = true; });
    expect(second).toMatchObject({ status: "created", campaign: { id: "camp_2" } });
    expect(storage.listCampaigns().map((c) => c.id)).toEqual(["camp_2"]);
  });
});

/**
 * Found while checking a live database: October had been sent to subscribers and its campaign then
 * deleted in Mailchimp. Asking the platform first answers "missing" for exactly that case, so a
 * month that had already gone out would have been published to the audience a second time.
 * Deleting a campaign does not un-send it.
 */
describe("a campaign that was sent and then deleted in the platform", () => {
  it("is still refused, however little the platform remembers of it", async () => {
    const mail = new FakeMail();
    let asked = 0;
    const gone = Object.assign(mail, {
      campaignState: async (): Promise<CampaignState> => { asked++; return "missing"; },
    });
    const first = review(gone);
    const created = await approve(first, built(first).key);
    expect(created).toMatchObject({ status: "created", campaign: { id: "camp_1" } });
    expect(await send(first, "camp_1")).toMatchObject({ status: "sent" });

    const st = review(gone);
    const again = await approve(st, built(st).key);
    expect(again).toMatchObject({ status: "period-sent", campaignId: "camp_1" });
    expect(asked, "a send on record is final; there is nothing to ask about").toBe(0);
    expect(mail.created, "the month must never go to the audience twice").toHaveLength(1);
  });
});
