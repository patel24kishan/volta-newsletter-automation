/**
 * What pressing Generate drafts does now: one newsletter in the configured layout, an older draft
 * retired so it cannot be approved by mistake, and a way back to the item list to fix the choice.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryAlerter } from "../src/alerts.js";
import { DRAFT_LAYOUTS, loadConfig, validateConfig } from "../src/config.js";
import { buildDrafts } from "../src/draft/templates.js";
import { rankItems } from "../src/pipeline/rank.js";
import { ACTION } from "../src/surface/blocks.js";
import { approveDraft, changeItems, generateDrafts, rememberSelection, sendReminder, type SlackClient, type SurfaceState } from "../src/surface/handlers.js";
import { sampleItem } from "./helpers.js";

const TZ = "America/Halifax";
const NOW = new Date("2026-09-15T12:00:00Z");
const items = [
  sampleItem({ type: "event", source: "volta-calendar", link: "https://www.eventbrite.ca/e/yoga", title: "Yoga", date: "2026-09-24T15:00:00Z", summary: "Join us for a 1-hour guided yoga session.", raw_excerpt: "Yoga Join us for a 1-hour guided yoga session.", location: "Volta" }),
  sampleItem({ link: "https://news.test/a", title: "Volta launches a program" }),
  sampleItem({ link: "https://news.test/b", title: "Volta opens applications" }),
];
const candidates = rankItems(items, NOW);
const fw = { date: "2026-09-21", weekday: "monday", weekMonday: "2026-09-21", skipped: [] };
const reminderInput = { candidates, preselectedIds: [items[0]!.id], firstWorkday: fw, timeZone: TZ, clockLabel: "real clock", sourceNotes: [] };

class FakeClient implements SlackClient {
  posts: Array<{ channel: string; text: string; blocks?: unknown[] }> = [];
  updates: Array<{ channel: string; ts: string; text: string; blocks?: unknown[] }> = [];
  failUpdates = false;
  async postMessage(args: { channel: string; text: string; blocks?: unknown[] }) { this.posts.push(args); return { ts: `${this.posts.length}.0`, channel: args.channel }; }
  async openDm(userId: string) { return `D_${userId}`; }
  async updateMessage(args: { channel: string; ts: string; text: string; blocks?: unknown[] }) {
    if (this.failUpdates) throw new Error("message_not_found");
    this.updates.push(args);
  }
}

let outDir: string;
beforeEach(() => { outDir = mkdtempSync(join(tmpdir(), "volta-gen-")); });
afterEach(() => { rmSync(outDir, { recursive: true, force: true }); });

function state(): SurfaceState {
  return {
    candidates: [...candidates], timeZone: TZ, outDir, drafts: new Map(), selections: new Map(),
    env: { ALLOW_LIVE: "1" }, campaigns: new Set(), layout: "events-first", now: () => NOW,
  };
}

/** Buttons in a message, i.e. only what sits in an actions block; context blocks also have elements. */
const actionsOf = (blocks: unknown[]): Array<{ action_id: string; value?: string; url?: string }> =>
  (blocks as Array<{ type?: string; elements?: Array<{ action_id: string; value?: string; url?: string }> }>)
    .filter((b) => b.type === "actions")
    .flatMap((b) => b.elements ?? []);

describe("the layout is config, not code", () => {
  it("builds only the layout asked for, and all three when none is", () => {
    expect(buildDrafts(items, { timeZone: TZ, layouts: ["events-first"] }).map((d) => d.id)).toEqual(["events-first"]);
    expect(buildDrafts(items, { timeZone: TZ, layouts: ["brief"] }).map((d) => d.id)).toEqual(["brief"]);
    expect(buildDrafts(items, { timeZone: TZ }).map((d) => d.id)).toEqual(DRAFT_LAYOUTS);
  });

  it("is required and checked, and the demo is set to events-first", async () => {
    const base = { timezone: TZ, send_day: "monday", reminder_time: "08:30", content_window_days: 7, events_window_days: 14, watchlist: ["Volta"], holiday_overrides: [], alert_recipients: ["bader"], sources: [{ id: "a", kind: "rss", type: "news", url: "https://x/feed", enabled: true }] };
    expect(validateConfig({ ...base, draft_layout: "brief" }).draft_layout).toBe("brief");
    expect(() => validateConfig({ ...base, draft_layout: "fancy" })).toThrow(/draft_layout/);
    expect(() => validateConfig(base)).toThrow(/draft_layout/);
    expect((await loadConfig("demo/config.json")).draft_layout).toBe("events-first");
  });
});

describe("pressing Generate drafts", () => {
  it("posts one newsletter, in the configured layout, with read, fix and commit in that order", async () => {
    const c = new FakeClient();
    const st = state();
    st.preview = { put: () => "https://preview.test/preview/abc" };

    const drafts = await generateDrafts(c, "D1", [items[0]!.id, items[1]!.id], st, new MemoryAlerter());

    expect(drafts.map((d) => d.id)).toEqual(["events-first"]);
    expect(c.posts).toHaveLength(1);
    expect(actionsOf(c.posts[0]!.blocks!).map((e) => e.action_id)).toEqual([ACTION.preview, ACTION.changeItems, ACTION.approve]);
    expect(JSON.stringify(c.posts[0]!.blocks)).toContain("built from 2 selected item(s)");
    expect(st.postedDraft).toMatchObject({ channel: "D1" });
    // Approve carries this generation's own key, not the layout name every draft shares.
    expect(actionsOf(c.posts[0]!.blocks!).at(-1)!.value).toBe(st.postedDraft!.key);
    expect(st.postedDraft!.key).not.toBe("events-first");
  });

  it("retires the previous draft, so a stale one cannot be approved by scrolling up", async () => {
    const c = new FakeClient();
    const st = state();
    await generateDrafts(c, "D1", [items[1]!.id], st, new MemoryAlerter());
    const firstTs = st.postedDraft!.ts!;
    const firstSubject = st.drafts.get(st.postedDraft!.key)!.draft.subject;

    await generateDrafts(c, "D1", [items[0]!.id, items[1]!.id], st, new MemoryAlerter());
    const secondSubject = st.drafts.get(st.postedDraft!.key)!.draft.subject;

    expect(c.updates).toHaveLength(1);
    expect(c.updates[0]!.ts).toBe(firstTs);
    expect(actionsOf(c.updates[0]!.blocks!)).toEqual([]); // its buttons are gone
    expect(JSON.stringify(c.updates[0]!.blocks)).toContain("A newer draft was generated below");
    // Regression: the retired message once named the newer draft, since it was read after replacing.
    expect(firstSubject).not.toBe(secondSubject);
    expect(JSON.stringify(c.updates[0]!.blocks)).toContain(firstSubject);
    expect(JSON.stringify(c.updates[0]!.blocks)).not.toContain(secondSubject);
    // The newest message is a complete draft, and it is the one Approve now acts on.
    expect(actionsOf(c.posts.at(-1)!.blocks!).at(-1)).toMatchObject({ action_id: ACTION.approve });
    expect(st.postedDraft!.ts).not.toBe(firstTs);
  });

  it("carries on when the older message can no longer be edited", async () => {
    const c = new FakeClient();
    const st = state();
    await generateDrafts(c, "D1", [items[0]!.id], st, new MemoryAlerter());
    c.failUpdates = true; // e.g. an earlier process posted it

    const drafts = await generateDrafts(c, "D1", [items[1]!.id], st, new MemoryAlerter());

    expect(drafts).toHaveLength(1);
    expect(c.posts).toHaveLength(2);
  });

  it("says what is held before showing the draft, and says nothing when nothing is held", async () => {
    const held = sampleItem({ link: "https://news.test/held", title: "Bellwether Soil", requires_review: true, hold_note: "Embargo, not editorial.", raw_excerpt: "Bellwether Soil news." });
    const c = new FakeClient();
    const st = state();
    st.candidates = rankItems([...items, held], NOW);

    await generateDrafts(c, "D1", [items[0]!.id, held.id], st, new MemoryAlerter());
    expect(c.posts).toHaveLength(2);
    expect(JSON.stringify(c.posts[0]!.blocks)).toContain("MARKED FOR REVIEW");
    expect(JSON.stringify(c.posts[1]!.blocks)).not.toContain("MARKED FOR REVIEW");

    const clean = new FakeClient();
    await generateDrafts(clean, "D1", [items[0]!.id], state(), new MemoryAlerter());
    expect(clean.posts).toHaveLength(1);
  });

  it("still refuses an empty selection and an unverifiable draft, reaching nobody in dry-run", async () => {
    const c = new FakeClient();
    const st = state();
    expect(await generateDrafts(c, "D1", [], st, new MemoryAlerter())).toEqual([]);
    expect(c.posts[0]!.text).toMatch(/Tick at least one item/);
    expect(st.postedDraft).toBeUndefined();

    const dry = state();
    dry.env = {};
    await expect(generateDrafts(new FakeClient(), "D1", [items[0]!.id], dry, new MemoryAlerter())).rejects.toThrow(/dry-run/);
  });
});

describe("Change the items", () => {
  it("brings the list back with everything still ticked, and a rebuild follows the new choice", async () => {
    const c = new FakeClient();
    const st = state();
    await sendReminder(c, "U_BADER", reminderInput, st);
    const firstListTs = st.reminder!.ts;
    rememberSelection(st, "D_U_BADER", [items[0]!.id, items[1]!.id]); // Bader ticked one more
    await generateDrafts(c, "D_U_BADER", [items[0]!.id, items[1]!.id], st, new MemoryAlerter());

    await changeItems(c, st);

    const list = c.posts.at(-1)!;
    const ticked = (list.blocks as Array<{ accessory?: { initial_options?: Array<{ value: string }> } }>)
      .flatMap((b) => (b.accessory?.initial_options ?? []).map((o) => o.value));
    expect(ticked).toEqual(expect.arrayContaining([items[0]!.id, items[1]!.id]));
    // The freshest list is the one a later addition updates.
    expect(st.reminder!.ts).not.toBe(firstListTs);
    expect(JSON.stringify(list.blocks)).toContain("Generate drafts");

    const rebuilt = await generateDrafts(c, "D_U_BADER", [items[2]!.id], st, new MemoryAlerter());
    expect(rebuilt[0]!.item_ids).toEqual([items[2]!.id]);
  });

  it("refuses in dry-run, and says so plainly when there is no list to bring back", async () => {
    const dry = state();
    dry.env = {};
    await expect(changeItems(new FakeClient(), dry)).rejects.toThrow(/dry-run/);
    await expect(changeItems(new FakeClient(), state())).rejects.toThrow(/not available/);
  });
});

describe("approving the one draft", () => {
  it("writes the files and names the layout", async () => {
    const c = new FakeClient();
    const st = state();
    await generateDrafts(c, "D1", [items[0]!.id], st, new MemoryAlerter());
    const paths = await approveDraft(c, "D1", st.postedDraft!.key, st);
    expect(paths).toBeDefined();
    expect(c.posts.at(-1)!.text).toMatch(/Approved: Events first/);
  });
});
