import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryAlerter } from "../src/alerts.js";
import { rankItems } from "../src/pipeline/rank.js";
import { DryRunRefusal } from "../src/runtime.js";
import { ACTION, draftBlocks, reminderBlocks, selectedIdsFromState } from "../src/surface/blocks.js";
import { approveDraft, generateDrafts, sendReminder, type SlackClient, type SurfaceState } from "../src/surface/handlers.js";
import { chunkMrkdwn, markdownToMrkdwn } from "../src/surface/mrkdwn.js";
import { buildDrafts } from "../src/draft/templates.js";
import { sampleItem } from "./helpers.js";

const TZ = "America/Halifax";
const now = new Date("2026-09-15T12:00:00Z");
const items = [
  sampleItem({ type: "event", source: "volta-calendar", link: "https://www.eventbrite.ca/e/yoga", title: "Yoga", date: "2026-09-24T15:00:00Z", summary: "Join us for a 1-hour guided yoga session.", raw_excerpt: "Yoga Join us for a 1-hour guided yoga session.", location: "Volta", related: [{ source: "volta-linkedin", link: "https://www.linkedin.com/posts/voltaeffect_yoga-activity-1-a", title: "Will we see you next Thursday?" }] }),
  sampleItem({ type: "linkedin", source: "volta-linkedin", link: "https://www.linkedin.com/posts/voltaeffect_chair-activity-2-b", title: "Pull up a chair and stay awhile.", date: "2026-09-15T11:00:00Z", summary: "Coffee, Community & Co-Work at Volta is back on Thursday, October 1.", raw_excerpt: "Pull up a chair and stay awhile. Coffee, Community & Co-Work at Volta is back on Thursday, October 1." }),
  ...Array.from({ length: 10 }, (_, i) => sampleItem({ type: "news", link: `https://news.test/${i}`, title: `Volta story number ${i}`, date: "2026-09-14T10:00:00Z", summary: `Story ${i} summary.`, raw_excerpt: `Volta story number ${i} Story ${i} summary.` })),
];
const candidates = rankItems(items, now);
const fw = { date: "2026-10-13", weekday: "tuesday", weekMonday: "2026-10-12", skipped: ["2026-10-12 monday: Volta closure (config override)"] };

class FakeClient implements SlackClient {
  posts: Array<{ channel: string; text: string; blocks?: unknown[]; thread_ts?: string }> = [];
  async postMessage(args: { channel: string; text: string; blocks?: unknown[]; thread_ts?: string }) { this.posts.push(args); return { ts: `${this.posts.length}.0`, channel: args.channel }; }
  async openDm(userId: string) { return `D_${userId}`; }
}

function state(outDir: string, env: NodeJS.ProcessEnv = { ALLOW_LIVE: "1" }): SurfaceState {
  return { candidates, timeZone: TZ, outDir, drafts: new Map(), selections: new Map(), env };
}

describe("mrkdwn", () => {
  it("converts headings, bold and links; escapes special characters in labels", () => {
    const md = "# Volta this week: Yoga\n\n## Upcoming events\n\n**Yoga**\nWhen: Thursday  \n[Event page](https://e/1) · [Also covered: A & B <x>](https://l/2)\n";
    const out = markdownToMrkdwn(md);
    expect(out).toContain("*Volta this week: Yoga*");
    expect(out).toContain("*Upcoming events*");
    expect(out).toContain("*Yoga*\nWhen: Thursday");
    expect(out).toContain("<https://e/1|Event page> · <https://l/2|Also covered: A &amp; B &lt;x&gt;>");
  });
  it("chunks long text under the section limit on paragraph boundaries", () => {
    const paras = Array.from({ length: 12 }, (_, i) => `para ${i} ` + "x".repeat(400));
    const chunks = chunkMrkdwn(paras.join("\n\n"), 1000);
    expect(chunks.length).toBeGreaterThan(4);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1000);
    expect(chunks.join("\n\n")).toBe(paras.join("\n\n"));
  });
});

describe("reminderBlocks", () => {
  const blocks = reminderBlocks({ candidates, preselectedIds: candidates.slice(0, 3).map((c) => c.item.id), firstWorkday: fw, timeZone: TZ, clockLabel: "overridden to 2026-10-13", sourceNotes: ["google-news: empty"] });

  it("splits 12 candidates into two checkbox groups of at most 10, pre-ticks the top three, and offers Generate", () => {
    const selects = blocks.filter((b) => typeof b.block_id === "string" && (b.block_id as string).startsWith("select_"));
    expect(selects).toHaveLength(2);
    const groups = selects.map((b) => (b.accessory as { options: unknown[]; initial_options?: unknown[] }));
    expect(groups[0]!.options).toHaveLength(10);
    expect(groups[1]!.options).toHaveLength(2);
    expect((groups[0]!.initial_options ?? []).length + (groups[1]!.initial_options ?? []).length).toBe(3);
    const gen = blocks.find((b) => b.block_id === "generate_actions") as { elements: Array<{ action_id: string; text: { text: string } }> };
    expect(gen.elements[0]).toMatchObject({ action_id: ACTION.generate, text: { text: "Generate drafts" } });
  });

  it("states the shifted first workday, the demo clock, and source notes in plain text", () => {
    const text = JSON.stringify(blocks);
    expect(text).toContain("Tuesday 2026-10-13");
    expect(text).toContain("skipped 2026-10-12 monday");
    expect(text).toContain("Demo clock");
    expect(text).toContain("google-news: empty");
  });

  it("every option links its item and labels type and date; empty candidate list says so", () => {
    const first = (blocks.find((b) => b.block_id === "select_0") as { accessory: { options: Array<{ text: { text: string }; description: { text: string }; value: string }> } }).accessory.options[0]!;
    expect(first.text.text).toMatch(/^<https:\/\/[^|]+\|.+>$/);
    expect(first.description.text).toMatch(/^(event|news|linkedin) · /);
    expect(first.value).toBe(candidates[0]!.item.id);
    const empty = reminderBlocks({ candidates: [], preselectedIds: [], firstWorkday: fw, timeZone: TZ, clockLabel: "real clock", sourceNotes: [] });
    expect(JSON.stringify(empty)).toContain("No items were found");
  });
});

describe("selectedIdsFromState", () => {
  it("collects values across select_* blocks only", () => {
    const st = { values: { select_0: { [ACTION.select]: { selected_options: [{ value: "a" }, { value: "b" }] } }, select_1: { [ACTION.select]: { selected_options: [{ value: "c" }] } }, other: { x: { selected_options: [{ value: "zzz" }] } } } };
    expect(selectedIdsFromState(st)).toEqual(["a", "b", "c"]);
    expect(selectedIdsFromState(undefined)).toEqual([]);
  });
});

describe("handlers", () => {
  let outDir: string;
  beforeEach(() => { outDir = mkdtempSync(join(tmpdir(), "volta-slack-")); });
  afterEach(() => { rmSync(outDir, { recursive: true, force: true }); });

  it("refuses every send in dry-run (ALLOW_LIVE unset)", async () => {
    const c = new FakeClient();
    const st = state(outDir, {});
    await expect(sendReminder(c, "U1", { candidates, preselectedIds: [], firstWorkday: fw, timeZone: TZ, clockLabel: "real clock", sourceNotes: [] }, st)).rejects.toThrow(DryRunRefusal);
    await expect(generateDrafts(c, "D1", [items[0]!.id], st, new MemoryAlerter())).rejects.toThrow(DryRunRefusal);
    await expect(approveDraft(c, "D1", "brief", st)).rejects.toThrow(DryRunRefusal);
    expect(c.posts).toHaveLength(0);
  });

  it("sends the reminder as a DM with blocks and a text fallback", async () => {
    const c = new FakeClient();
    const r = await sendReminder(c, "U1", { candidates, preselectedIds: [], firstWorkday: fw, timeZone: TZ, clockLabel: "real clock", sourceNotes: [] }, state(outDir));
    expect(r.channel).toBe("D_U1");
    expect(c.posts[0]!.text).toMatch(/12 candidate item/);
    expect(c.posts[0]!.blocks!.length).toBeGreaterThan(3);
  });

  it("generates verified drafts from the selection, posts each with an Approve button, and Approve writes final files", async () => {
    const c = new FakeClient();
    const st = state(outDir);
    const alerter = new MemoryAlerter();
    const good = await generateDrafts(c, "D1", [items[0]!.id, items[1]!.id], st, alerter);
    expect(good.map((d) => d.id)).toEqual(["brief", "standard", "events-first"]);
    expect(alerter.sent).toEqual([]);
    expect(c.posts).toHaveLength(4); // summary + 3 drafts
    const approveBtn = (c.posts[1]!.blocks!.at(-1) as { elements: Array<{ action_id: string; value: string }> }).elements[0]!;
    expect(approveBtn).toMatchObject({ action_id: ACTION.approve, value: "brief" });
    expect(JSON.stringify(c.posts[2]!.blocks)).toContain("<https://www.eventbrite.ca/e/yoga|Event page>");
    expect(JSON.stringify(c.posts[2]!.blocks)).not.toContain("Volta story number");

    const paths = await approveDraft(c, "D1", "standard", st);
    expect(paths).toBeDefined();
    expect(existsSync(paths!.html)).toBe(true);
    expect(readFileSync(paths!.md, "utf8")).toContain("**Yoga**");
    expect(c.posts.at(-1)!.text).toMatch(/Approved: Standard/);
  });

  it("empty selection and unknown draft ids get a plain-language message, not a crash", async () => {
    const c = new FakeClient();
    const st = state(outDir);
    expect(await generateDrafts(c, "D1", [], st, new MemoryAlerter())).toEqual([]);
    expect(c.posts[0]!.text).toMatch(/Tick at least one item/);
    expect(await approveDraft(c, "D1", "nope", st)).toBeUndefined();
    expect(c.posts[1]!.text).toMatch(/no longer available/);
  });

  it("draftBlocks carry the verification status and split long drafts into several sections", () => {
    const d = buildDrafts(items, { timeZone: TZ })[1]!;
    const blocks = draftBlocks(d, 1, 3);
    expect(JSON.stringify(blocks[1])).toContain("verified: yes");
    expect(blocks.filter((b) => b.type === "section").length).toBeGreaterThanOrEqual(1);
    for (const b of blocks.filter((b) => b.type === "section")) expect(((b.text as { text: string }).text).length).toBeLessThanOrEqual(3000);
  });
});
