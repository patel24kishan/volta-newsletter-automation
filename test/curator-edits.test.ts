/**
 * E1: the curator's own wording, per item, kept apart from the source text and applied to every
 * draft build for the period.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryAlerter } from "../src/alerts.js";
import { rankItems } from "../src/pipeline/rank.js";
import { verifyDraft } from "../src/pipeline/verify.js";
import { applyEdits, normalizeEdit } from "../src/review/edits.js";
import { buildDraft, candidateGroups, editItem, setSelection, startReview, type ReviewState } from "../src/review/review.js";
import { SqliteStorage } from "../src/storage.js";
import { sampleItem } from "./helpers.js";

const TZ = "America/Halifax";
const RUN = new Date("2026-10-01T11:30:00Z");
const PERIOD = "2026-10";

const mixer = sampleItem({
  type: "event", source: "volta-calendar", link: "https://www.eventbrite.ca/e/mixer", title: "Fall Mixer", date: "2026-10-22T21:00:00Z",
  summary: "Meet the fall cohort.", raw_excerpt: "Fall Mixer Meet the fall cohort.", location: "Volta", event_timing: "upcoming",
});
const story = sampleItem({ link: "https://news.test/a", title: "Volta launches a program" });
const update = sampleItem({
  type: "member_social", source: "member-updates", link: "https://volta.slack.com/archives/C1/p1", title: "Tidewell: Dashboard launch.",
  summary: "Advice for the editor.", insights: ["Launched a dashboard for harbour pilots."], raw_excerpt: "Tidewell Launched a dashboard for harbour pilots.",
});

let storage: SqliteStorage;
beforeEach(() => { storage = new SqliteStorage(":memory:"); });
afterEach(() => storage.close());

function review(): ReviewState {
  const st: ReviewState = {
    candidates: [], timeZone: TZ, outDir: ".", drafts: new Map(), selections: new Map(), env: {}, campaigns: new Set(),
    session: storage, edits: storage, week: PERIOD, layout: "events-first", cadence: "monthly", now: () => RUN,
  };
  const candidates = rankItems([mixer, story, update], RUN);
  startReview(st, { candidates, preselectedIds: [mixer.id, story.id], period: PERIOD, firstWorkday: { date: "2026-10-01", weekday: "thursday", weekMonday: "2026-09-28", skipped: [] }, timeZone: TZ, clockLabel: "test", sourceNotes: [] });
  return st;
}
const draftOf = (st: ReviewState) => {
  const r = buildDraft(st, new MemoryAlerter());
  if (!r.ok) throw new Error(`no draft: ${r.reason}`);
  return r;
};

describe("checking an edit before it is saved", () => {
  it("accepts a description, location, link or date and time, in the curator's words", () => {
    expect(normalizeEdit(mixer, "summary", "  Drinks,   demos and the fall cohort. ", TZ)).toEqual({ value: "Drinks, demos and the fall cohort." });
    expect(normalizeEdit(mixer, "location", "Volta, 1505 Barrington St", TZ)).toEqual({ value: "Volta, 1505 Barrington St" });
    expect(normalizeEdit(mixer, "link", "https://lu.ma/mixer", TZ)).toEqual({ value: "https://lu.ma/mixer" });
    // A link fixed after the event was added is typed the same way it is typed on the add form.
    expect(normalizeEdit(mixer, "link", "lu.ma/mixer", TZ)).toEqual({ value: "https://lu.ma/mixer" });
    expect(normalizeEdit(mixer, "link", " www.eventbrite.ca/e/1 ", TZ)).toEqual({ value: "https://www.eventbrite.ca/e/1" });
    expect(normalizeEdit(mixer, "starts_at", "2026-10-23 19:00", TZ)).toEqual({ value: "2026-10-23T22:00:00.000Z" }); // 19:00 ADT
  });

  it("refuses what cannot be right, saying what to do instead", () => {
    expect(normalizeEdit(mixer, "summary", "   ", TZ)).toEqual({ error: expect.stringMatching(/clear the edit instead/) });
    expect(normalizeEdit(mixer, "link", "a link to the page", TZ)).toEqual({ error: expect.stringMatching(/https:\/\//) });
    expect(normalizeEdit(mixer, "starts_at", "Oct 23 7pm", TZ)).toEqual({ error: expect.stringMatching(/YYYY-MM-DD HH:MM/) });
    expect(normalizeEdit(mixer, "starts_at", "2026-02-30 19:00", TZ)).toEqual({ error: "2026-02-30 is not a real date." });
    expect(normalizeEdit(story, "location", "Volta", TZ)).toEqual({ error: "only an event has a location" });
    // A sourced event keeps the title its source gave it; only an event Bader added can be retitled.
    expect(normalizeEdit(mixer, "title", "Fall Party", TZ)).toEqual({ error: expect.stringMatching(/only be changed on an event you added; this one comes from volta-calendar/) });
    expect(normalizeEdit(mixer, "headline", "x", TZ)).toEqual({ error: expect.stringMatching(/headline cannot be edited/) });
    expect(normalizeEdit(mixer, "summary", "x".repeat(601), TZ)).toEqual({ error: expect.stringMatching(/under 600/) });
  });
});

describe("applying edits", () => {
  it("changes a copy and says which fields, leaving the source item untouched", () => {
    const edits = [{ period: PERIOD, item_id: mixer.id, field: "summary", value: "Drinks and demos.", edited_at: "x" }];
    const [edited] = applyEdits([mixer], edits, RUN);
    expect(edited!.summary).toBe("Drinks and demos.");
    expect(edited!.edited_fields).toEqual(["summary"]);
    expect(mixer.summary).toBe("Meet the fall cohort.");
    expect(mixer.edited_fields).toBeUndefined();
  });

  it("replaces a member update's points with the curator's description", () => {
    const [edited] = applyEdits([update], [{ period: PERIOD, item_id: update.id, field: "summary", value: "Tidewell shipped its pilot dashboard.", edited_at: "x" }], RUN);
    expect(edited!.insights).toBeUndefined();
    expect(edited!.summary).toBe("Tidewell shipped its pilot dashboard.");
  });
});

describe("editing in the review", () => {
  it("is saved for the period and appears in the draft, listed as the curator's", () => {
    const st = review();
    const r = editItem(st, mixer.id, "summary", "Drinks, demos and the fall cohort.");
    expect("item" in r && r.item.summary).toBe("Drinks, demos and the fall cohort.");
    expect(storage.listCuratorEdits(PERIOD)).toHaveLength(1);
    const d = draftOf(st);
    expect(d.draft.markdown).toContain("Drinks, demos and the fall cohort.");
    expect(d.draft.markdown).not.toContain("Meet the fall cohort.");
    expect(d.draft.verification.ok).toBe(true);
    expect(d.notes.edited).toEqual([{ id: mixer.id, title: "Fall Mixer", fields: ["description"] }]);
  });

  it("survives a change of selection, including being unticked and ticked again", () => {
    const st = review();
    editItem(st, mixer.id, "location", "Volta, 1505 Barrington St");
    setSelection(st, [story.id]);
    expect(draftOf(st).draft.markdown).not.toContain("Barrington");
    setSelection(st, [story.id, mixer.id]);
    expect(draftOf(st).draft.markdown).toContain("Where: Volta, 1505 Barrington St");
  });

  it("clearing an edit brings the source's text back", () => {
    const st = review();
    editItem(st, mixer.id, "summary", "Drinks and demos.");
    editItem(st, mixer.id, "summary", null);
    expect(storage.listCuratorEdits(PERIOD)).toEqual([]);
    expect(draftOf(st).draft.markdown).toContain("Meet the fall cohort.");
  });

  it("a new date moves the event to the section it now belongs in", () => {
    const st = review();
    editItem(st, mixer.id, "starts_at", "2026-09-25 18:00"); // before the run: already held
    expect(candidateGroups(st).pastEvents.map((c) => c.item.title)).toEqual(["Fall Mixer"]);
    const md = draftOf(st).draft.markdown;
    expect(md).toContain("## Last month at Volta");
    expect(md).toContain("Held: Friday, September 25, 6:00 pm");
  });

  it("refuses an item that is not a candidate, and returns field errors instead of saving", () => {
    const st = review();
    expect(editItem(st, "google-news:nope", "summary", "x")).toEqual({ error: expect.stringMatching(/not one of this period's candidates/) });
    expect(editItem(st, mixer.id, "link", "not a link")).toEqual({ error: expect.stringMatching(/https:\/\//) });
    expect(storage.listCuratorEdits(PERIOD)).toEqual([]);
  });

  it("belongs to its period: October's edits do not touch November's review", () => {
    const st = review();
    editItem(st, mixer.id, "summary", "Drinks and demos.");
    expect(storage.listCuratorEdits("2026-11")).toEqual([]);
  });
});

describe("the verifier and the curator's words", () => {
  it("accepts a name only because the curator wrote it", () => {
    const st = review();
    editItem(st, story.id, "summary", "Jane Doe of Harbour Labs joins as mentor in residence.");
    const d = draftOf(st);
    expect(d.draft.verification.ok).toBe(true);
    // The same text checked against the source items alone is rejected: nothing else vouches for it.
    const sourceOnly = verifyDraft(d.draft.markdown, [mixer, story], { timeZone: TZ, allow: [] });
    expect(sourceOnly.ok).toBe(false);
    expect(sourceOnly.violations.map((v) => v.value).join(" ")).toMatch(/Jane Doe|Harbour Labs/);
  });
});
