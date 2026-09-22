/**
 * A draft that fails verification. The verifier's corpus is the items' own text, so no item can
 * trip it; it guards against a template that writes something no source said. The template is
 * mocked here to do exactly that, in a file of its own so no other test sees the mock.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryAlerter } from "../src/alerts.js";
import { rankItems } from "../src/pipeline/rank.js";
import { buildDraft, currentDraft, startReview, type ReviewState } from "../src/review/review.js";
import { sampleItem } from "./helpers.js";

const state = { fabricate: false };
vi.mock("../src/draft/templates.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/draft/templates.js")>();
  return {
    ...real,
    buildDrafts: (...args: Parameters<typeof real.buildDrafts>) => real.buildDrafts(...args).map((d) =>
      state.fabricate ? { ...d, verification: { ...d.verification, ok: false, violations: [{ kind: "entity", value: "Acme Megacorp" }] } } : d),
  };
});

const NOW = new Date("2026-09-21T12:00:00Z");
const story = sampleItem({ link: "https://news.test/a", title: "Volta launches a program" });
let outDir: string;
beforeEach(() => { outDir = mkdtempSync(join(tmpdir(), "volta-unverified-")); state.fabricate = false; });
afterEach(() => rmSync(outDir, { recursive: true, force: true }));

describe("an unverifiable draft", () => {
  it("is withheld with an alert, and the previous draft stays approvable", () => {
    const st: ReviewState = { candidates: [], timeZone: "America/Halifax", outDir, drafts: new Map(), selections: new Map(), env: {}, campaigns: new Set(), now: () => NOW };
    const candidates = rankItems([story], NOW);
    startReview(st, { candidates, preselectedIds: [story.id], firstWorkday: { date: "2026-09-21", weekday: "monday", weekMonday: "2026-09-21", skipped: [] }, timeZone: "America/Halifax", clockLabel: "test", sourceNotes: [] });
    const good = buildDraft(st, new MemoryAlerter());
    if (!good.ok) throw new Error("expected a draft");

    state.fabricate = true;
    const alerter = new MemoryAlerter();
    const bad = buildDraft(st, alerter);
    expect(bad).toMatchObject({ ok: false, reason: "not-verified", violations: [{ kind: "entity", value: "Acme Megacorp" }] });
    expect(alerter.sent.filter((a) => a.level === "error")).toHaveLength(1);
    expect(currentDraft(st)!.key).toBe(good.key);
  });
});
