/**
 * The Slack side of adding an event no source lists: the button, the form, and what happens when
 * it is submitted. The data path it feeds is covered in manual-events.test.ts.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SourceConfig } from "../src/config.js";
import { rankItems } from "../src/pipeline/rank.js";
import { DryRunRefusal } from "../src/runtime.js";
import { SqliteStorage } from "../src/storage.js";
import { ACTION, ADD_EVENT, addEventErrorBlocks, addEventFields, addEventView, MANUAL_LABEL, reminderBlocks } from "../src/surface/blocks.js";
import { addManualEvent, rememberSelection, sendReminder, type SlackClient, type SurfaceState } from "../src/surface/handlers.js";
import { sampleItem } from "./helpers.js";

const TZ = "America/Halifax";
const NOW = new Date("2026-09-21T12:00:00Z");
const SOURCE = { id: "manual-events", kind: "manual", type: "event", url: "", fallback_link: "https://voltaeffect.com/events", enabled: true } as SourceConfig & { fallback_link: string };
const fw = { date: "2026-09-21", weekday: "monday", weekMonday: "2026-09-21", skipped: [] };
const existing = rankItems([
  sampleItem({ link: "https://news.test/a", title: "Volta story one" }),
  sampleItem({ link: "https://news.test/b", title: "Volta story two" }),
], NOW);

const FORM = { title: "Demo Night", date: "2026-09-25", time: "19:00", location: "Volta, Halifax", description: "An evening of founder demos.", link: "" };

class FakeClient implements SlackClient {
  posts: Array<{ channel: string; text: string; blocks?: unknown[]; thread_ts?: string }> = [];
  updates: Array<{ channel: string; ts: string; text: string; blocks?: unknown[] }> = [];
  failUpdates = false;
  async postMessage(args: { channel: string; text: string; blocks?: unknown[]; thread_ts?: string }) { this.posts.push(args); return { ts: `${this.posts.length}.0`, channel: args.channel }; }
  async openDm(userId: string) { return `D_${userId}`; }
  async updateMessage(args: { channel: string; ts: string; text: string; blocks?: unknown[] }) {
    if (this.failUpdates) throw new Error("message_not_found");
    this.updates.push(args);
  }
}

let storage: SqliteStorage;
let outDir: string;
beforeEach(() => {
  storage = new SqliteStorage(":memory:");
  outDir = mkdtempSync(join(tmpdir(), "volta-mes-"));
});
afterEach(() => {
  storage.close();
  rmSync(outDir, { recursive: true, force: true });
});

function state(env: NodeJS.ProcessEnv = { ALLOW_LIVE: "1" }): SurfaceState {
  return {
    candidates: [...existing], timeZone: TZ, outDir, drafts: new Map(), selections: new Map(), env,
    campaigns: new Set(), storage, manualSource: SOURCE, now: () => NOW,
  };
}

/** The ids ticked in a reminder's checkbox groups. */
function tickedIn(blocks: Array<Record<string, unknown>>): string[] {
  return blocks.flatMap((b) => {
    const acc = b.accessory as { initial_options?: Array<{ value: string }> } | undefined;
    return (acc?.initial_options ?? []).map((o) => o.value);
  });
}

describe("the Add an event button", () => {
  const blocks = reminderBlocks({ candidates: existing, preselectedIds: [], firstWorkday: fw, timeZone: TZ, clockLabel: "real clock", sourceNotes: [] });

  it("sits in the reminder without disturbing Generate drafts", () => {
    const add = blocks.find((b) => b.block_id === "add_event_actions") as { elements: Array<{ action_id: string; text: { text: string } }> };
    expect(add.elements[0]).toMatchObject({ action_id: ACTION.addEvent, text: { text: "Add an event" } });
    const gen = blocks.find((b) => b.block_id === "generate_actions") as { elements: Array<{ action_id: string; text: { text: string } }> };
    expect(gen.elements).toHaveLength(1);
    expect(gen.elements[0]).toMatchObject({ action_id: ACTION.generate, text: { text: "Generate drafts" } });
  });

  it("is offered even in a week when every source was quiet", () => {
    const quiet = reminderBlocks({ candidates: [], preselectedIds: [], firstWorkday: fw, timeZone: TZ, clockLabel: "real clock", sourceNotes: [] });
    expect(quiet.some((b) => b.block_id === "add_event_actions")).toBe(true);
    expect(JSON.stringify(quiet)).toContain("Nothing to select");
  });

  it("leaves the message well within Slack's 50-block limit on a busy week", () => {
    const many = rankItems(Array.from({ length: 40 }, (_, i) => sampleItem({ link: `https://news.test/${i}`, title: `Volta story number ${i}` })), NOW);
    const busy = reminderBlocks({ candidates: many, preselectedIds: many.slice(0, 10).map((c) => c.item.id), firstWorkday: fw, timeZone: TZ, clockLabel: "real clock", sourceNotes: [] });
    expect(busy.length).toBeLessThanOrEqual(50);
  });
});

describe("the form", () => {
  const view = addEventView({ timeZone: TZ, now: NOW }) as { blocks: Array<Record<string, unknown>>; callback_id: string; title: { text: string } };

  it("asks for a name, date and time, and marks the rest optional", () => {
    expect(view.callback_id).toBe(ADD_EVENT.callbackId);
    const byId = new Map(view.blocks.filter((b) => b.type === "input").map((b) => [b.block_id as string, b]));
    expect([...byId.keys()]).toEqual([ADD_EVENT.field.title, ADD_EVENT.field.date, ADD_EVENT.field.time, ADD_EVENT.field.location, ADD_EVENT.field.description, ADD_EVENT.field.link]);
    for (const required of [ADD_EVENT.field.title, ADD_EVENT.field.date, ADD_EVENT.field.time]) expect(byId.get(required)!.optional).toBeUndefined();
    for (const optional of [ADD_EVENT.field.location, ADD_EVENT.field.description, ADD_EVENT.field.link]) expect(byId.get(optional)!.optional).toBe(true);
    expect((byId.get(ADD_EVENT.field.date)!.element as { initial_date: string }).initial_date).toBe("2026-09-21");
  });

  it("says which timezone the time is read in, and what a blank link or description does", () => {
    const text = JSON.stringify(view);
    expect(text).toContain(`In ${TZ} time.`);
    expect(text).toContain("Blank links to the events page instead.");
    expect(text).toContain("needing a summary");
  });

  it("reads back what was filled in, and puts each complaint under its own field", () => {
    const submitted = {
      values: {
        [ADD_EVENT.field.title]: { [ADD_EVENT.value]: { value: " Demo Night " } },
        [ADD_EVENT.field.date]: { [ADD_EVENT.value]: { selected_date: "2026-09-25" } },
        [ADD_EVENT.field.time]: { [ADD_EVENT.value]: { selected_time: "19:00" } },
        [ADD_EVENT.field.link]: { [ADD_EVENT.value]: { value: null } },
      },
    };
    expect(addEventFields(submitted)).toEqual({ title: "Demo Night", date: "2026-09-25", time: "19:00", location: "", description: "", link: "" });
    expect(addEventErrorBlocks({ title: "Enter a title.", starts_at: "Choose a start time in the future." })).toEqual({
      [ADD_EVENT.field.title]: "Enter a title.",
      [ADD_EVENT.field.date]: "Choose a start time in the future.",
    });
  });
});

describe("submitting the form", () => {
  it("adds the event to the list, ticked, and keeps what was ticked before", async () => {
    const c = new FakeClient();
    const st = state();
    await sendReminder(c, "U_BADER", { candidates: existing, preselectedIds: [existing[0]!.item.id], firstWorkday: fw, timeZone: TZ, clockLabel: "real clock", sourceNotes: [] }, st);
    rememberSelection(st, "D_U_BADER", existing.map((e) => e.item.id)); // Bader ticked the second one too

    const { item, errors } = await addManualEvent(c, FORM, st);

    expect(errors).toBeUndefined();
    expect(item!.title).toBe("Demo Night");
    expect(item!.date).toBe("2026-09-25T22:00:00.000Z"); // 7pm Halifax, not 7pm UTC
    expect(st.candidates.map((x) => x.item.id)).toContain(item!.id);
    // One list, edited in place, with every earlier tick intact.
    expect(c.updates).toHaveLength(1);
    const ticked = tickedIn(c.updates[0]!.blocks as Array<Record<string, unknown>>);
    expect(ticked).toEqual(expect.arrayContaining([...existing.map((e) => e.item.id), item!.id]));
    expect(JSON.stringify(c.updates[0]!.blocks)).toContain(MANUAL_LABEL);
    expect(c.posts.at(-1)!.text).toContain('Added "Demo Night"');
  });

  it("stores it, so it survives a restart and comes back on the next run", async () => {
    const st = state();
    await addManualEvent(new FakeClient(), FORM, st);
    expect(storage.listManualEvents("2026-09-21T12:00:00Z", "2026-10-05T12:00:00Z").map((e) => e.title)).toEqual(["Demo Night"]);
  });

  it("rejects a bad link or a start in the past, and adds nothing", async () => {
    const st = state();
    const before = st.candidates.length;
    const bad = await addManualEvent(new FakeClient(), { ...FORM, link: "voltaeffect.com" }, st);
    expect(bad.errors).toHaveProperty("link");
    expect(bad.item).toBeUndefined();
    const past = await addManualEvent(new FakeClient(), { ...FORM, date: "2026-09-01" }, st);
    expect(past.errors).toHaveProperty("starts_at");
    const blank = await addManualEvent(new FakeClient(), { ...FORM, title: "   " }, st);
    expect(blank.errors).toHaveProperty("title");
    expect(st.candidates).toHaveLength(before);
    expect(storage.listManualEvents("2020-01-01T00:00:00Z", "2030-01-01T00:00:00Z")).toEqual([]);
  });

  it("refuses in dry-run, like every other thing that reaches a person", async () => {
    await expect(addManualEvent(new FakeClient(), FORM, state({}))).rejects.toBeInstanceOf(DryRunRefusal);
    expect(storage.listManualEvents("2020-01-01T00:00:00Z", "2030-01-01T00:00:00Z")).toEqual([]);
  });

  it("posts a fresh list when the original message can no longer be edited", async () => {
    const c = new FakeClient();
    const st = state();
    const first = await sendReminder(c, "U_BADER", { candidates: existing, preselectedIds: [], firstWorkday: fw, timeZone: TZ, clockLabel: "real clock", sourceNotes: [] }, st);
    c.failUpdates = true; // e.g. the process restarted since the reminder went out

    const { item } = await addManualEvent(c, FORM, st);

    expect(c.updates).toHaveLength(0);
    const fresh = c.posts.at(-1)!;
    expect(tickedIn(fresh.blocks as Array<Record<string, unknown>>)).toContain(item!.id);
    // The newest message is the one a later addition should edit.
    expect(st.reminder!.ts).toBeDefined();
    expect(st.reminder!.ts).not.toBe(first.ts);
  });

  it("says so rather than pretending, when no manual source is configured", async () => {
    const st = state();
    delete st.manualSource;
    await expect(addManualEvent(new FakeClient(), FORM, st)).rejects.toThrow(/no manual events source/);
  });
});
