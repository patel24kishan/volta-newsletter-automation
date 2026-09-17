import { describe, expect, it } from "vitest";
import { condense } from "../src/pipeline/condense.js";

// The reader-facing points of real write-ups from #newsletter-keynotes.
const COVE = [
  "14-month procurement cycle: 9 months privacy review, 3 months budget timing, 2 months lost to staff turnover.",
  "Transferable lesson, clearly stated: document the case for your product so it survives your champion leaving. She lost her champion twice; the written handover cut recovery from 3 months to 1 week.",
  "Pilot is 6 months, 3 rural clinics, ~1,200 patients, with a genuine pass/fail evaluation. She pushed back on any framing that presumes success.",
];
const LANTERN = [
  "Headline metric: 18% empty miles versus a ~35% industry average. Yuki volunteered the caveats — own network, own definition, small sample — without being pushed.",
  "Three new hires, all deliberately from outside logistics, after two industry hires dismissed core parts of the model as impossible.",
  "He explicitly confirmed he wants the remark published despite the risk.",
];

const words = (points: string[]) => points.join(" ").split(/\s+/).filter(Boolean).length;

describe("condense", () => {
  it("cuts a write-up to at most two single-sentence points", () => {
    const out = condense(COVE);
    expect(out).toEqual([
      "14-month procurement cycle: 9 months privacy review, 3 months budget timing, 2 months lost to staff turnover.",
      "Pilot is 6 months, 3 rural clinics, ~1,200 patients, with a genuine pass/fail evaluation.",
    ]);
    expect(words(out)).toBeLessThan(words(COVE) / 2);
  });

  it("prefers the sentence with the figure, and the one that opens its bullet, over asides", () => {
    expect(condense(LANTERN)).toEqual([
      "Headline metric: 18% empty miles versus a ~35% industry average.",
      "Three new hires, all deliberately from outside logistics, after two industry hires dismissed core parts of the model as impossible.",
    ]);
  });

  it("only ever outputs sentences the source wrote, in the order it wrote them", () => {
    for (const points of [COVE, LANTERN]) {
      const source = points.join(" ");
      const out = condense(points);
      let from = 0;
      for (const p of out) {
        const at = source.indexOf(p, from);
        expect(at, p).toBeGreaterThanOrEqual(0);
        from = at + p.length;
      }
    }
  });

  it("passes over a sentence that judges the material when a factual one is available", () => {
    const out = condense([
      "The tension is the story here and it is a better angle than most.",
      "Forty units across four designs go on sale in October.",
    ], { maxPoints: 1 });
    expect(out).toEqual(["Forty units across four designs go on sale in October."]);
  });

  it("stays within the word budget but always keeps one point", () => {
    const long = "A ".repeat(60).trim() + " figure of 12 percent was reported.";
    expect(condense([long, "Second point with 3 things."], { maxWords: 20 })).toHaveLength(1);
    expect(condense([long], { maxWords: 5 })).toHaveLength(1);
  });

  it("cuts an over-long sentence at a word boundary", () => {
    const out = condense(["This sentence has 1 figure and then " + "keeps going ".repeat(40) + "until the end."], { maxPointChars: 80 });
    expect(out[0]!.length).toBeLessThanOrEqual(81);
    expect(out[0]!.endsWith("…")).toBe(true);
    expect(out[0]).not.toMatch(/\s…$/);
  });

  it("keeps a decimal figure whole", () => {
    expect(condense(["Closed a $1.4M seed, led out of Montréal with two local angels. More detail follows here."], { maxPoints: 1 }))
      .toEqual(["Closed a $1.4M seed, led out of Montréal with two local angels."]);
  });

  it("returns nothing for nothing, and ignores fragments too short to mean anything", () => {
    expect(condense([])).toEqual([]);
    expect(condense(["", "  "])).toEqual([]);
    expect(condense(["Yes.", "Agreed."])).toEqual([]);
  });
});
