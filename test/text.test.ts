import { describe, expect, it } from "vitest";
import { firstSentences, splitSentences } from "../src/text.js";

describe("splitSentences", () => {
  it("splits on sentence boundaries", () => {
    expect(splitSentences("One. Two two! Three?")).toEqual(["One.", "Two two!", "Three?"]);
  });

  it("never loses text: the pieces always rebuild the input", () => {
    const samples = [
      "Closed a $1.4M seed, led out of Montréal. Nadia asked that the raise not lead.",
      "Ottawa puts $8.5 million behind 40 projects. More at https://ow.ly/LFHr50ZCvv9 today.",
      "Runs on v2.0 of the API. See docs.example.com for details.",
      "\"'The market is too small' often means 'I don't know this market.'\" Confirmed she is happy.",
      "No ending punctuation here",
      "Ends mid. lowercase continues here. Then Upper.",
    ];
    for (const s of samples) expect(splitSentences(s).join(" "), s).toBe(s);
  });

  it("does not treat a decimal point, a version number or a domain as the end of a sentence", () => {
    expect(splitSentences("Closed a $1.4M seed. Next.")).toEqual(["Closed a $1.4M seed.", "Next."]);
    expect(splitSentences("Runs on v2.0 now. Good.")).toEqual(["Runs on v2.0 now.", "Good."]);
    expect(splitSentences("See docs.example.com today. Thanks.")).toEqual(["See docs.example.com today.", "Thanks."]);
  });

  it("keeps closing quotes with the sentence they close", () => {
    expect(splitSentences("He said \"go.\" Then left.")).toEqual(["He said \"go.\"", "Then left."]);
  });

  it("handles empty and whitespace-only input", () => {
    expect(splitSentences("")).toEqual([]);
    expect(splitSentences("   \n ")).toEqual([]);
  });
});

describe("firstSentences", () => {
  it("keeps a figure with a decimal point whole (regression: \"$1.4M\" became \"4M\")", () => {
    expect(firstSentences("Closed a $1.4M seed, led out of Montréal. Nadia asked that it not lead. Third.", 2, 280))
      .toBe("Closed a $1.4M seed, led out of Montréal. Nadia asked that it not lead.");
    expect(firstSentences("Ottawa puts $8.5 million behind 40 projects. Second.", 1, 280)).toBe("Ottawa puts $8.5 million behind 40 projects.");
  });

  it("still truncates at a word boundary", () => {
    const out = firstSentences("word ".repeat(100), 1, 40);
    expect(out.length).toBeLessThanOrEqual(41);
    expect(out.endsWith("…")).toBe(true);
  });
});
