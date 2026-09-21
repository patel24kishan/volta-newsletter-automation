/**
 * The Slack review survives a restart. Each restart here is real: one SqliteStorage on a file is
 * closed and a second is opened on the same file, then a fresh SurfaceState is built exactly the
 * way demo-slack builds it at startup (loadReview, loadCampaigns, restoreSession). A save that was
 * missed anywhere would show up as a button that stops working after the restart.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryAlerter } from "../src/alerts.js";
import type { SourceConfig } from "../src/config.js";
import { rankItems } from "../src/pipeline/rank.js";
import type { PublishedCampaign, Publisher } from "../src/publish/types.js";
import { SqliteStorage } from "../src/storage.js";
import { REVIEW_LABEL } from "../src/surface/blocks.js";
import { addManualEvent, approveDraft, changeItems, generateDrafts, rememberSelection, sendCampaign, sendReminder, type SlackClient, type SurfaceState } from "../src/surface/handlers.js";
import { serialQueue } from "../src/surface/serial.js";
import { loadCampaigns, loadReview, parseSession, restoreSession, SESSION_VERSION, snapshotOf } from "../src/surface/session.js";
import { sampleItem } from "./helpers.js";

const TZ = "America/Halifax";
const NOW = new Date("2026-09-21T12:00:00Z");
const WEEK = "2026-09-21";
const NEXT_WEEK = "2026-09-28";
const SECRETS = { SLACK_BOT_TOKEN: "xoxb-super-secret-token", SLACK_APP_TOKEN: "xapp-super-secret", MAILCHIMP_API_KEY: "mc-super-secret-us2" };

const event = sampleItem({ type: "event", source: "volta-calendar", link: "https://www.eventbrite.ca/e/yoga", title: "Yoga", date: "2026-09-24T15:00:00Z", summary: "Join us for a 1-hour guided yoga session.", raw_excerpt: "Yoga Join us for a 1-hour guided yoga session.", location: "Volta" });
const newsA = sampleItem({ link: "https://news.test/a", title: "Volta launches a program" });
const newsB = sampleItem({ link: "https://news.test/b", title: "Volta opens applications", summary: "Applications open for founders.", raw_excerpt: "Volta opens applications Applications open for founders." });
const held = sampleItem({ link: "https://news.test/held", title: "Bellwether Soil", requires_review: true, hold_note: "Embargo, not editorial.", raw_excerpt: "Bellwether Soil news." });
const candidates = rankItems([event, newsA, newsB, held], NOW);
const fw = { date: WEEK, weekday: "monday", weekMonday: WEEK, skipped: [] };
const reminderInput = { candidates, preselectedIds: [event.id, newsA.id], firstWorkday: fw, timeZone: TZ, clockLabel: "real clock", sourceNotes: [] };
const MANUAL: SourceConfig & { fallback_link: string } = { id: "manual-events", kind: "manual", type: "event", url: "", fallback_link: "https://voltaeffect.com/events", enabled: true };

class FakeClient implements SlackClient {
  posts: Array<{ channel: string; text: string; blocks?: unknown[]; thread_ts?: string; ts: string }> = [];
  updates: Array<{ channel: string; ts: string; text: string; blocks?: unknown[] }> = [];
  failUpdates = false;
  /** Makes the next post whose text starts with this fail, as a Slack outage would. */
  failPostStartingWith: string | undefined;
  async postMessage(args: { channel: string; text: string; blocks?: unknown[]; thread_ts?: string }) {
    if (this.failPostStartingWith && args.text.startsWith(this.failPostStartingWith)) {
      this.failPostStartingWith = undefined;
      throw new Error("Slack is unavailable");
    }
    const ts = `${this.posts.length + 1}.0`;
    this.posts.push({ ...args, ts });
    return { ts, channel: args.channel };
  }
  async openDm(userId: string) { return `D_${userId}`; }
  async updateMessage(args: { channel: string; ts: string; text: string; blocks?: unknown[] }) {
    if (this.failUpdates) throw new Error("message_not_found");
    this.updates.push(args);
  }
}

class FakeMail implements Publisher {
  readonly platform = "Mailchimp";
  created: string[] = [];
  sent: string[] = [];
  /** Slows publishing, so a second click can arrive while the first is still waiting. */
  delayMs = 0;
  async verify() { return { audienceName: "Test list", memberCount: 2 }; }
  async publishDraft(): Promise<PublishedCampaign> {
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    const id = `camp_${this.created.length + 1}`;
    this.created.push(id);
    return { id, editUrl: `https://mc.test/edit/${id}`, platform: this.platform };
  }
  async send(id: string) { this.sent.push(id); }
}

let dir: string;
let path: string;
const open: SqliteStorage[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "volta-session-"));
  path = join(dir, "newsletter.sqlite");
});
afterEach(() => {
  for (const s of open.splice(0)) { try { s.close(); } catch { /* already closed */ } }
  rmSync(dir, { recursive: true, force: true });
});

function storage(): SqliteStorage {
  const s = new SqliteStorage(path);
  open.push(s);
  return s;
}

function fresh(s: SqliteStorage, publisher?: Publisher, week = WEEK): SurfaceState {
  const st: SurfaceState = {
    candidates: [...candidates], timeZone: TZ, outDir: dir, drafts: new Map(), selections: new Map(),
    env: { ALLOW_LIVE: "1", ...SECRETS }, campaigns: new Set(), now: () => NOW, layout: "events-first",
    session: s, week, storage: s, manualSource: MANUAL,
  };
  if (publisher) { st.publisher = publisher; st.audience = { audienceName: "Test list", memberCount: 2 }; }
  return st;
}

/** Close the database and start again the way demo-slack does after a deploy. */
function restart(before: SqliteStorage, publisher?: Publisher, week = WEEK): { s: SqliteStorage; st: SurfaceState } {
  before.close();
  const s = storage();
  const st = fresh(s, publisher, week);
  st.candidates = []; // nothing re-fetched: the list comes back from the saved review
  const loaded = loadReview(s, week);
  if (loaded && "error" in loaded) throw new Error(loaded.error);
  loadCampaigns(st, s);
  if (loaded) restoreSession(st, loaded.snapshot);
  return { s, st };
}

const approveValue = (blocks: unknown[] | undefined): string =>
  ((blocks as Array<{ type?: string; elements?: Array<{ action_id: string; value?: string }> }>)
    .filter((b) => b.type === "actions").flatMap((b) => b.elements ?? [])
    .find((e) => e.action_id === "newsletter_approve")!).value!;

describe("storage for the review", () => {
  it("saves and loads a week's review, overwrites it, and knows nothing of other weeks", () => {
    const s = storage();
    expect(s.loadSession(WEEK)).toBeUndefined();
    s.saveSession(WEEK, '{"a":1}');
    s.saveSession(WEEK, '{"a":2}');
    expect(s.loadSession(WEEK)).toBe('{"a":2}');
    expect(s.loadSession(NEXT_WEEK)).toBeUndefined();
  });

  it("records a campaign once, marks it sent once, and keeps it whatever the week", () => {
    const s = storage();
    s.recordCampaign("c1", "k1");
    s.recordCampaign("c1", "k1"); // harmless when repeated
    expect(s.listCampaigns()).toEqual([expect.objectContaining({ id: "c1", draft_key: "k1", sent_at: null })]);
    s.markCampaignSent("c1");
    const sentAt = s.listCampaigns()[0]!.sent_at;
    expect(sentAt).toEqual(expect.any(String));
    s.markCampaignSent("c1"); // the first send time stands
    expect(s.listCampaigns()[0]!.sent_at).toBe(sentAt);
  });

  it("adds its tables to a database created before this existed, leaving its rows alone", () => {
    const old = new DatabaseSync(path);
    old.exec("CREATE TABLE items (id TEXT PRIMARY KEY, source TEXT NOT NULL, type TEXT NOT NULL, date TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL, needs_summary INTEGER NOT NULL, link TEXT NOT NULL, source_ref TEXT NOT NULL, confidence TEXT NOT NULL, requires_review INTEGER NOT NULL, raw_excerpt TEXT NOT NULL, fetched_at TEXT NOT NULL)");
    old.exec("INSERT INTO items VALUES ('x', 'src', 'news', '2026-09-14T12:00:00.000Z', 't', 's', 0, 'https://x.test', 'r', 'high', 0, 'e', '2026-09-14T12:00:00.000Z')");
    old.close();
    const s = storage();
    expect(s.countItems()).toBe(1);
    s.saveSession(WEEK, "{}");
    s.recordCampaign("c1", "k1");
    expect(s.loadSession(WEEK)).toBe("{}");
    expect(s.listCampaigns()).toHaveLength(1);
  });
});

describe("what is saved", () => {
  it("never contains a token, and round-trips the selections, drafts and verification", async () => {
    const s = storage();
    const st = fresh(s);
    await sendReminder(new FakeClient(), "U1", reminderInput, st);
    await generateDrafts(new FakeClient(), "D_U1", [event.id, newsA.id], st, new MemoryAlerter());

    const raw = s.loadSession(WEEK)!;
    for (const secret of Object.values(SECRETS)) expect(raw).not.toContain(secret);
    expect(raw).not.toContain("ALLOW_LIVE");

    const parsed = parseSession(raw);
    expect("snapshot" in parsed).toBe(true);
    const snap = (parsed as { snapshot: ReturnType<typeof snapshotOf> & object }).snapshot;
    expect(snap.v).toBe(SESSION_VERSION);
    expect(snap.selections["D_U1"]).toEqual([event.id, newsA.id]);
    expect(snap.drafts).toHaveLength(1);
    expect(snap.drafts[0]!.draft.verification.ok).toBe(true);
    expect(snap.drafts[0]!.items.map((i) => i.id)).toEqual([event.id, newsA.id]);
  });

  it("sets aside a corrupt or older snapshot instead of failing", () => {
    expect(parseSession("{not json")).toEqual({ error: expect.stringContaining("not valid JSON") });
    expect(parseSession(JSON.stringify({ v: 0 }))).toEqual({ error: expect.stringContaining("version 0") });
    expect(parseSession(JSON.stringify({ v: SESSION_VERSION, selections: {}, drafts: [] }))).toEqual({ error: expect.stringContaining("no usable reminder") });
    const s = storage();
    s.saveSession(WEEK, "{not json");
    expect(loadReview(s, WEEK)).toEqual({ error: expect.any(String) });
  });

  it("belongs to one week: the same week finds it, the next week starts with nothing", async () => {
    const s = storage();
    await sendReminder(new FakeClient(), "U1", reminderInput, fresh(s));
    expect(loadReview(s, WEEK)).toEqual({ snapshot: expect.objectContaining({ reminder: expect.objectContaining({ sentAt: NOW.toISOString() }) }) });
    expect(loadReview(s, NEXT_WEEK)).toBeUndefined();
  });
});

describe("a restart in the middle of a review", () => {
  it("keeps the reminder's own ticks when Bader had not ticked anything yet", async () => {
    const s = storage();
    await sendReminder(new FakeClient(), "U1", reminderInput, fresh(s));
    const { st } = restart(s);
    expect(st.selections.get("D_U1")).toEqual([event.id, newsA.id]);
    expect(st.candidates.map((c) => c.item.id)).toEqual(candidates.map((c) => c.item.id));
  });

  it("between Generate and Approve: Approve still works, and still warns about a held item", async () => {
    const s = storage();
    const st = fresh(s, new FakeMail());
    const c = new FakeClient();
    await sendReminder(c, "U1", reminderInput, st);
    await generateDrafts(c, "D_U1", [event.id, held.id], st, new MemoryAlerter());
    const key = approveValue(c.posts.at(-1)!.blocks);

    const mail = new FakeMail();
    const after = restart(s, mail);
    after.st.candidates = []; // even if the list no longer held that item
    const c2 = new FakeClient();
    const paths = await approveDraft(c2, "D_U1", key, after.st);

    expect(paths).toBeDefined();
    expect(mail.created).toEqual(["camp_1"]);
    expect(JSON.stringify(c2.posts.at(-1)!.blocks)).toContain(`This newsletter includes 1 item ${REVIEW_LABEL}`);
  });

  it("between Approve and Send: Send still works, once", async () => {
    const s = storage();
    const st = fresh(s, new FakeMail());
    const c = new FakeClient();
    await sendReminder(c, "U1", reminderInput, st);
    await generateDrafts(c, "D_U1", [event.id], st, new MemoryAlerter());
    await approveDraft(c, "D_U1", approveValue(c.posts.at(-1)!.blocks), st);

    const mail = new FakeMail();
    const { st: st2 } = restart(s, mail);
    const c2 = new FakeClient();
    expect(await sendCampaign(c2, "D_U1", "camp_1", st2)).toBe(true);
    expect(mail.sent).toEqual(["camp_1"]);
    // A second press, even after yet another restart, is refused by name.
    expect(await sendCampaign(c2, "D_U1", "camp_1", st2)).toBe(false);
    expect(c2.posts.at(-1)!.text).toMatch(/already been sent/);
    const { st: st3 } = restart(open.at(-1)!, mail);
    expect(await sendCampaign(new FakeClient(), "D_U1", "camp_1", st3)).toBe(false);
    expect(await sendCampaign(new FakeClient(), "D_U1", "camp_unknown", st3)).toBe(false);
    expect(mail.sent).toEqual(["camp_1"]);
  });

  it("across a week boundary: a campaign approved on Friday can still be sent on Monday", async () => {
    const s = storage();
    const st = fresh(s, new FakeMail());
    const c = new FakeClient();
    await sendReminder(c, "U1", reminderInput, st);
    await generateDrafts(c, "D_U1", [event.id], st, new MemoryAlerter());
    await approveDraft(c, "D_U1", approveValue(c.posts.at(-1)!.blocks), st);

    const mail = new FakeMail();
    const { st: monday } = restart(s, mail, NEXT_WEEK);
    expect(monday.drafts.size).toBe(0); // a new week is a new review
    expect(await sendCampaign(new FakeClient(), "D_U1", "camp_1", monday)).toBe(true);
    expect(mail.sent).toEqual(["camp_1"]);
  });

  it("between two Generates: the old message is retired by its saved time and keeps its own subject", async () => {
    const s = storage();
    const st = fresh(s);
    const c = new FakeClient();
    await sendReminder(c, "U1", reminderInput, st);
    await generateDrafts(c, "D_U1", [newsB.id], st, new MemoryAlerter());
    const firstTs = st.postedDraft!.ts!;
    const firstSubject = st.drafts.get(st.postedDraft!.key)!.draft.subject;

    const { st: st2 } = restart(s);
    const c2 = new FakeClient();
    await generateDrafts(c2, "D_U1", [event.id], st2, new MemoryAlerter());

    expect(c2.updates).toHaveLength(1);
    expect(c2.updates[0]!.ts).toBe(firstTs);
    const retired = JSON.stringify(c2.updates[0]!.blocks);
    expect(retired).toContain(firstSubject);
    expect(retired).not.toContain(st2.drafts.get(st2.postedDraft!.key)!.draft.subject);
  });

  it("then adding an event edits the saved list, and a list posted afresh is the one saved", async () => {
    const s = storage();
    const c = new FakeClient();
    const reminderTs = (await sendReminder(c, "U1", reminderInput, fresh(s))).ts;

    const first = restart(s);
    const c2 = new FakeClient();
    await addManualEvent(c2, { title: "Demo Night", date: "2026-09-25", time: "19:00" }, first.st);
    expect(c2.updates[0]!.ts).toBe(reminderTs);

    const second = restart(first.s);
    const c3 = new FakeClient();
    c3.failUpdates = true;
    await addManualEvent(c3, { title: "Office Hours", date: "2026-09-26", time: "10:00" }, second.st);
    const freshTs = c3.posts.at(-1)!.ts;
    const third = restart(second.s);
    expect(third.st.reminder!.ts).toBe(freshTs);
    // Both events came back in the list as it was shown, without fetching anything.
    expect(third.st.candidates.map((x) => x.item.title)).toEqual(expect.arrayContaining(["Demo Night", "Office Hours"]));
  });

  it("then Change the items still brings the list back", async () => {
    const s = storage();
    const st = fresh(s);
    await sendReminder(new FakeClient(), "U1", reminderInput, st);
    rememberSelection(st, "D_U1", [newsB.id]);
    const { st: st2 } = restart(s);
    const c = new FakeClient();
    await changeItems(c, st2);
    const ticked = (c.posts.at(-1)!.blocks as Array<{ accessory?: { initial_options?: Array<{ value: string }> } }>)
      .flatMap((b) => (b.accessory?.initial_options ?? []).map((o) => o.value));
    expect(ticked).toEqual([newsB.id]);
  });
});

describe("a stale or repeated click", () => {
  it("an Approve left on an earlier draft is refused and the newer draft is untouched", async () => {
    const s = storage();
    const mail = new FakeMail();
    const st = fresh(s, mail);
    const c = new FakeClient();
    await sendReminder(c, "U1", reminderInput, st);
    await generateDrafts(c, "D_U1", [newsB.id], st, new MemoryAlerter());
    const oldKey = approveValue(c.posts.at(-1)!.blocks);
    await generateDrafts(c, "D_U1", [event.id], st, new MemoryAlerter());
    const newKey = approveValue(c.posts.at(-1)!.blocks);
    expect(newKey).not.toBe(oldKey);

    expect(await approveDraft(c, "D_U1", oldKey, st)).toBeUndefined();
    expect(c.posts.at(-1)!.text).toMatch(/no longer available/);
    expect(mail.created).toEqual([]);
    expect(await approveDraft(c, "D_U1", newKey, st)).toBeDefined();
    expect(mail.created).toEqual(["camp_1"]);
  });

  it("remembers the campaign even when the confirmation fails after Mailchimp succeeded", async () => {
    const s = storage();
    const mail = new FakeMail();
    const st = fresh(s, mail);
    const c = new FakeClient();
    await sendReminder(c, "U1", reminderInput, st);
    await generateDrafts(c, "D_U1", [event.id], st, new MemoryAlerter());
    const key = approveValue(c.posts.at(-1)!.blocks);
    c.failPostStartingWith = "Approved:";

    await expect(approveDraft(c, "D_U1", key, st)).rejects.toThrow(/Slack is unavailable/);

    expect(s.listCampaigns().map((x) => x.id)).toEqual(["camp_1"]);
    // After a restart the campaign is still sendable, and approving again does not make another.
    const after = restart(s, mail);
    expect(await approveDraft(new FakeClient(), "D_U1", key, after.st)).toBeDefined();
    expect(mail.created).toEqual(["camp_1"]);
    expect(await sendCampaign(new FakeClient(), "D_U1", "camp_1", after.st)).toBe(true);
  });

  it("two Approve presses at once make one campaign", async () => {
    const s = storage();
    const mail = new FakeMail();
    mail.delayMs = 20; // the second press arrives while the first is still waiting on Mailchimp
    const st = fresh(s, mail);
    const c = new FakeClient();
    await sendReminder(c, "U1", reminderInput, st);
    await generateDrafts(c, "D_U1", [event.id], st, new MemoryAlerter());
    const key = approveValue(c.posts.at(-1)!.blocks);

    const oneAtATime = serialQueue();
    await Promise.all([
      oneAtATime(async () => { await approveDraft(c, "D_U1", key, st); }),
      oneAtATime(async () => { await approveDraft(c, "D_U1", key, st); }),
    ]);

    expect(mail.created).toEqual(["camp_1"]);
    expect(c.posts.at(-1)!.text).toMatch(/Already approved/);
  });

  it("two Generates at once leave only the newest draft approvable", async () => {
    const s = storage();
    const st = fresh(s, new FakeMail());
    const c = new FakeClient();
    await sendReminder(c, "U1", reminderInput, st);

    const oneAtATime = serialQueue();
    await Promise.all([
      oneAtATime(async () => { await generateDrafts(c, "D_U1", [newsB.id], st, new MemoryAlerter()); }),
      oneAtATime(async () => { await generateDrafts(c, "D_U1", [event.id], st, new MemoryAlerter()); }),
    ]);

    // "This week's newsletter:" is a draft; the reminder reads "This week's newsletter is ready".
    const draftPosts = c.posts.filter((p) => p.text.startsWith("This week's newsletter:"));
    expect(draftPosts).toHaveLength(2);
    const [older, newer] = draftPosts.map((p) => approveValue(p.blocks));
    expect(st.drafts.size).toBe(1);
    expect(st.drafts.has(newer!)).toBe(true);
    expect(st.drafts.has(older!)).toBe(false);
    // The older message was retired, so its Approve button is gone from Slack as well.
    expect(c.updates.map((u) => u.ts)).toEqual([draftPosts[0]!.ts]);
  });
});
