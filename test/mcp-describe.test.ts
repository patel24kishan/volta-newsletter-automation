/**
 * What the candidate list tells Claude about each item. Found testing in the Claude app: a founder
 * update's summary is the write-up's advice to the editor, and shown as the item's text it read as
 * missing copy, so Claude offered to write some. The list now says what will actually print.
 */
import { describe, expect, it } from "vitest";
import { describeItem, INSTRUCTIONS } from "../src/mcp/newsletter-server.js";
import { sampleItem } from "./helpers.js";

const TZ = "America/Halifax";

describe("an item in the candidate list", () => {
  it("shows a founder update's printed points, and its advice to the editor as a note that is not printed", () => {
    const update = sampleItem({
      type: "member_social", source: "member-updates", title: "Harbourlight Robotics: Seed round closed.",
      summary: "Run it as a rejection story and ask for a photo of the arm.",
      insights: ["Closed a $1.4M seed round.", "Hiring two engineers in Dartmouth."],
      editor_notes: ["Confirm the amount with the founder before publishing."],
    });
    const text = describeItem(update, true, TZ);
    expect(text).toContain("  prints:\n    • Closed a $1.4M seed round.\n    • Hiring two engineers in Dartmouth.");
    expect(text).toContain("  note to editor (not printed): Run it as a rejection story and ask for a photo of the arm.");
    expect(text).toContain("  note to editor (not printed): Confirm the amount with the founder before publishing.");
    expect(text).not.toMatch(/prints:[^\n]*rejection story/);
  });

  it("shows an ordinary item's description as what prints, and says so when there is none", () => {
    expect(describeItem(sampleItem({ summary: "Volta launched a program for founders." }), false, TZ)).toContain("  prints: Volta launched a program for founders.");
    expect(describeItem(sampleItem({ summary: "", needs_summary: true }), false, TZ)).toContain("  prints: the title only (the source gave no description)");
  });

  it("marks ticks, past events and the curator's edits", () => {
    const past = sampleItem({ type: "event", title: "Demo Night", date: "2026-09-17T22:00:00Z", location: "Volta", event_timing: "past", edited_fields: ["summary"] });
    const line = describeItem(past, false, TZ).split("\n")[0]!;
    expect(line).toBe("- [ ] Demo Night | held 2026-09-17 19:00 at Volta | edited by Bader: description");
  });
});

describe("the rules Claude is given", () => {
  it("forbid offering to write copy, and ask for the list to be shown rather than summarised", () => {
    expect(INSTRUCTIONS).toMatch(/never offer to write, rewrite or "fill in" copy/);
    expect(INSTRUCTIONS).toMatch(/note to editor \(not printed\)" are advice for Bader/);
    expect(INSTRUCTIONS).toMatch(/Do not replace the list with a summary/);
  });
});
