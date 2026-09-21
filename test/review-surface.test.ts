import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryAlerter } from "../src/alerts.js";
import { buildDrafts } from "../src/draft/templates.js";
import { rankItems } from "../src/pipeline/rank.js";
import type { Item } from "../src/schema.js";
import { ACTION, REVIEW_LABEL, approvedBlocks, draftNotesBlocks, reminderBlocks } from "../src/surface/blocks.js";
import { approveDraft, generateDrafts, type SlackClient, type SurfaceState } from "../src/surface/handlers.js";
import { chunkEntries } from "../src/surface/mrkdwn.js";
import { sampleItem } from "./helpers.js";

const TZ = "America/Halifax";
const now = new Date("2026-09-17T23:00:00Z");
const fw = { date: "2026-09-14", weekday: "monday", weekMonday: "2026-09-14", skipped: [] };

const held: Item = sampleItem({
  type: "member_social", source: "member-updates",
  link: "https://ghost24.slack.com/archives/C0C2H7WAUJX/p1789674541369439",
  title: "Bellwether Soil: Good material, can't run it yet.",
  date: "2026-09-17T19:49:01Z",
  summary: "Federal agri-innovation grant confirmed, embargoed until Sep 30. Non-embargoed material is solid.",
  raw_excerpt: "Bellwether Soil · Marc Comeau, co-founder. Federal agri-innovation grant confirmed, embargoed until Sep 30. Non-embargoed material is solid: 11 farms.",
  requires_review: true,
  hold_note: "REVISIT w/c Sep 28 (embargo)",
  byline: "Marc Comeau, co-founder",
  insights: ["Federal agri-innovation grant confirmed, embargoed until Sep 30.", "Non-embargoed material is solid: 11 farms.", "A third point."],
  editor_notes: ["Why it's held: Embargo, not editorial.", "Revisit at end of month: Confirm the announcement went ahead on Sep 30 before publishing anything."],
});

const clear: Item = sampleItem({
  type: "member_social", source: "member-updates", link: "https://ghost24.slack.com/archives/C0C2H7WAUJX/p1789674526650499",
  title: "Northcast: Open beta of the fisheries weather API.", date: "2026-09-17T19:48:46Z",
  summary: "the line that makes the problem legible.", raw_excerpt: "Northcast · Iris Thibodeau, founder. Open beta of a hyperlocal marine forecast API.",
  byline: "Iris Thibodeau, founder", insights: ["Open beta of a hyperlocal marine forecast API."],
  editor_notes: ["Comparison data promised — chase it, and don't publish the claim without it."],
});

/** Long LinkedIn-style links, as the live list really has, so the list outgrows one Slack section. */
function manyItems(n: number): Item[] {
  return Array.from({ length: n }, (_, i) => sampleItem({
    type: "linkedin", link: `https://www.linkedin.com/posts/voltaeffect_a-fairly-long-slug-for-a-post-about-something-${i}-activity-75056569612214190${String(i).padStart(2, "0")}-qsNs`,
    title: `A LinkedIn post with a reasonably long opening line, number ${i}`, date: "2026-09-16T10:00:00Z",
  }));
}

describe("chunkEntries", () => {
  it("packs whole entries under the limit, splitting none and dropping none", () => {
    const entries = Array.from({ length: 30 }, (_, i) => `${i + 1}. ${"x".repeat(180)}`);
    const chunks = chunkEntries(entries, 1000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1000);
    expect(chunks.join("\n").split("\n")).toEqual(entries);
  });

  it("keeps a multi-line entry together", () => {
    const multi = "20. MARKED\n      • one\n      • two";
    const chunks = chunkEntries(["a".repeat(80), multi, "b".repeat(80)], 100);
    expect(chunks.some((c) => c === multi)).toBe(true);
  });
});

describe("the candidate list", () => {
  it("links every candidate, however many there are (regression: entries past 2900 characters lost their links)", () => {
    const candidates = rankItems([...manyItems(24), held, clear], now);
    const blocks = reminderBlocks({ candidates, preselectedIds: [], firstWorkday: fw, timeZone: TZ, clockLabel: "real clock", sourceNotes: [] });
    const json = JSON.stringify(blocks);

    for (const c of candidates) expect(json, c.item.title).toContain(`<${c.item.link}|`);
    const sections = blocks.filter((b) => b.type === "section");
    for (const s of sections) expect(((s.text as { text: string }).text).length).toBeLessThanOrEqual(3000);
    expect(blocks.length).toBeLessThanOrEqual(50);
  });

  it("shows a held item in full: the label first, two points, why it is held, and the link to that message", () => {
    const candidates = rankItems([held, clear], now);
    const blocks = reminderBlocks({ candidates, preselectedIds: [clear.id], firstWorkday: fw, timeZone: TZ, clockLabel: "real clock", sourceNotes: [] });
    const list = blocks.filter((b) => b.type === "section").map((b) => (b.text as { text: string }).text).find((t) => t.includes("Bellwether"))!;
    const entry = list.split("\n").slice(list.split("\n").findIndex((l) => l.includes("Bellwether")));

    expect(entry[0]).toMatch(new RegExp(`^\\d+\\. \\*${REVIEW_LABEL}\\* · <https://ghost24\\.slack\\.com/archives/C0C2H7WAUJX/p1789674541369439\\|Bellwether Soil`));
    expect(entry[1]).toContain("• Federal agri-innovation grant confirmed, embargoed until Sep 30.");
    expect(entry[2]).toContain("• Non-embargoed material is solid: 11 farms.");
    expect(entry[3]).toContain("On hold: REVISIT w/c Sep 28 (embargo)");
    // Two points, not three.
    expect(list).not.toContain("A third point.");

    // A clear item stays a single line, without the label.
    const clearLine = list.split("\n").find((l) => l.includes("Northcast"))!;
    expect(clearLine).not.toContain(REVIEW_LABEL);
  });

  it("labels the held item on its checkbox too, and never pre-ticks it", () => {
    const candidates = rankItems([held, clear], now);
    const blocks = reminderBlocks({ candidates, preselectedIds: [clear.id], firstWorkday: fw, timeZone: TZ, clockLabel: "real clock", sourceNotes: [] });
    const group = blocks.find((b) => b.block_id === "select_0") as { accessory: { options: Array<{ text: { text: string }; value: string }>; initial_options?: Array<{ value: string }> } };
    const heldOption = group.accessory.options.find((o) => o.value === held.id)!;
    expect(heldOption.text.text).toMatch(new RegExp(`^\\d+\\. ${REVIEW_LABEL}: Bellwether Soil`));
    expect(heldOption.text.text.length).toBeLessThan(151);
    expect((group.accessory.initial_options ?? []).map((o) => o.value)).toEqual([clear.id]);
  });
});

describe("what the curator is told alongside the drafts", () => {
  it("names the held items that were selected, and passes on every note to the editor", () => {
    const text = JSON.stringify(draftNotesBlocks([held, clear]));
    expect(text).toContain(`1 selected item is ${REVIEW_LABEL}`);
    expect(text).toContain("Bellwether Soil: Good material");
    expect(text).toContain("on hold: REVISIT w/c Sep 28 (embargo)");
    expect(text).toContain("Notes to the editor from the write-ups");
    expect(text).toContain("Confirm the announcement went ahead on Sep 30 before publishing anything.");
    expect(text).toContain("don't publish the claim without it");
  });

  it("says nothing when there is nothing to say", () => {
    expect(draftNotesBlocks([sampleItem()])).toEqual([]);
  });

  it("the approval message and the Send confirmation both name a held item that is about to go out", () => {
    const draft = buildDrafts([held, clear], { timeZone: TZ })[1]!;
    const blocks = approvedBlocks(draft, { html: "out/final.html", md: "out/final.md" }, { id: "c1", editUrl: "https://mail.test/e", platform: "Mailchimp", audienceName: "Volta", memberCount: 2 }, [held]);
    const text = JSON.stringify(blocks);
    expect(text).toContain(`This newsletter includes 1 item ${REVIEW_LABEL}`);
    const send = (blocks.at(-1) as { elements: Array<{ action_id: string; confirm?: { text: { text: string } } }> }).elements.find((e) => e.action_id === ACTION.send)!;
    expect(send.confirm!.text.text).toContain("It includes 1 item marked for review: Bellwether Soil.");
    // With nothing held, neither warning appears.
    expect(JSON.stringify(approvedBlocks(draft, { html: "a", md: "b" }, { id: "c1", editUrl: "https://mail.test/e", platform: "Mailchimp", audienceName: "Volta", memberCount: 2 }))).not.toContain(REVIEW_LABEL);
  });
});

class FakeSlack implements SlackClient {
  posts: Array<{ channel: string; text: string; blocks?: unknown[] }> = [];
  async postMessage(args: { channel: string; text: string; blocks?: unknown[] }) { this.posts.push(args); return { ts: "1.0", channel: args.channel }; }
  async openDm(userId: string) { return `D_${userId}`; }
}

describe("selecting a held item, end to end", () => {
  let outDir: string;
  beforeEach(() => { outDir = mkdtempSync(join(tmpdir(), "volta-review-")); });
  afterEach(() => { rmSync(outDir, { recursive: true, force: true }); });

  it("the drafts read cleanly while Slack carries the warning at generate and again at approve", async () => {
    const slack = new FakeSlack();
    const st: SurfaceState = { candidates: rankItems([held, clear], now), timeZone: TZ, outDir, drafts: new Map(), selections: new Map(), env: { ALLOW_LIVE: "1" }, campaigns: new Set() };

    const drafts = await generateDrafts(slack, "D1", [held.id, clear.id], st, new MemoryAlerter());
    expect(drafts).toHaveLength(1);

    // First message: the held warning and the notes to the editor.
    expect(JSON.stringify(slack.posts[0]!.blocks)).toContain(`1 selected item is ${REVIEW_LABEL}`);
    // The draft itself, as posted to Slack, carries no label and no notes.
    for (const post of slack.posts.slice(1)) {
      const body = JSON.stringify(post.blocks);
      expect(body).not.toContain(REVIEW_LABEL);
      expect(body).not.toContain("Why it's held");
      expect(body).toContain("Key insights");
    }

    await approveDraft(slack, "D1", "events-first", st);
    expect(JSON.stringify(slack.posts.at(-1)!.blocks)).toContain(`This newsletter includes 1 item ${REVIEW_LABEL}`);
  });
});
