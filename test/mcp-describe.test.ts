/**
 * What the candidate list tells Claude about each item. Found testing in the Claude app: a founder
 * update's summary is the write-up's advice to the editor, and shown as the item's text it read as
 * missing copy, so Claude offered to write some. The list now says what will actually print.
 */
import { describe, expect, it } from "vitest";
import { describeItem, draftNotesText, INSTRUCTIONS } from "../src/mcp/newsletter-server.js";
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

describe("full text and held items, as in the Slack list", () => {
  it("never shortens an item's text", () => {
    const long = "A".repeat(150) + " middle " + "B".repeat(150) + " the very end.";
    const text = describeItem(sampleItem({ summary: long }), false, TZ);
    expect(text).toContain(`  prints: ${long}`);
    expect(text).not.toContain("...");
  });

  it("leads a held item with MARKED FOR REVIEW, then its points, then why it is on hold", () => {
    const held = sampleItem({
      type: "member_social", source: "member-updates", title: "Bellwether Soil: Good material, can't run it yet.", requires_review: true,
      hold_note: "REVISIT w/c Sep 28 (embargo)", insights: ["Won a provincial soil-health grant.", "Pilot farms named after the funder announces."],
    });
    expect(describeItem(held, false, TZ).split("\n")).toEqual([
      "- [ ] MARKED FOR REVIEW · Bellwether Soil: Good material, can't run it yet. | member_social from member-updates, 2026-09-14",
      `  id: ${held.id}`,
      "  prints:",
      "    • Won a provincial soil-health grant.",
      "    • Pilot farms named after the funder announces.",
      "  note to editor (not printed): Volta launched a program for founders.",
      "  On hold: REVISIT w/c Sep 28 (embargo)",
      `  link: ${held.link}`,
    ]);
  });
});

describe("the notes that come with a built draft", () => {
  it("follow the Slack wording: held items, then notes to the editor, then what Bader changed", () => {
    expect(draftNotesText({
      held: [{ id: "a", title: "Bellwether Soil", hold_note: "Embargo until Sep 30" }],
      editorNotes: [{ id: "b", title: "Cove Health", notes: ["Avoid the phrase successful pilot.", "Confirm the partner's name."] }],
      edited: [{ id: "c", title: "Fall Mixer", fields: ["description", "location"] }],
    })).toEqual([
      "**1 selected item is MARKED FOR REVIEW.** It is in this draft because you ticked it. Check the hold still applies before you send.",
      "• **Bellwether Soil** · on hold: Embargo until Sep 30",
      "",
      "**Notes to the editor from the write-ups** (not in the newsletter)",
      "**Cove Health**",
      "      • Avoid the phrase successful pilot.",
      "      • Confirm the partner's name.",
      "",
      "**Changed by you**",
      "• **Fall Mixer**: description, location",
    ]);
  });

  it("say nothing when there is nothing to say, and count held items in the plural", () => {
    expect(draftNotesText({ held: [], editorNotes: [], edited: [] })).toEqual([]);
    const two = draftNotesText({ held: [{ id: "a", title: "A" }, { id: "b", title: "B" }], editorNotes: [], edited: [] });
    expect(two[0]).toBe("**2 selected items are MARKED FOR REVIEW.** They are in this draft because you ticked them. Check the hold still applies before you send.");
  });
});

describe("the rules Claude is given", () => {
  it("keep full text and the review labels", () => {
    expect(INSTRUCTIONS).toMatch(/Do not shorten any item's text/);
    expect(INSTRUCTIONS).toMatch(/Keep "MARKED FOR REVIEW" and "On hold:" exactly as returned/);
  });

  it("forbid offering to write copy, and ask for the list to be shown rather than summarised", () => {
    expect(INSTRUCTIONS).toMatch(/never offer to write, rewrite or "fill in" copy/);
    expect(INSTRUCTIONS).toMatch(/For add_source, use only what Bader gives you/);
    expect(INSTRUCTIONS).toMatch(/never invent a feed and never add one he did not name/);
    expect(INSTRUCTIONS).toMatch(/never let its empty section pass as/);
    // Bader says a few words, not a sentence: each short phrase must land on one tool.
    expect(INSTRUCTIONS).toMatch(/"sources", "list sources", "what do we read\?" -> list_sources/);
    expect(INSTRUCTIONS).toMatch(/"add source", "add feed", "add calendar", "add channel", or a link on its own -> add_source/);
    expect(INSTRUCTIONS).toMatch(/"turn off X", "pause X", "turn on X" -> set_source/);
    expect(INSTRUCTIONS).toMatch(/"remove source", "delete source", "stop reading X" -> remove_source, after he has said to/);
    expect(INSTRUCTIONS).toMatch(/"refresh", "refresh this month", "fetch again" -> prepare_month with force/);
    expect(INSTRUCTIONS).toMatch(/ask only for what is missing/);

    expect(INSTRUCTIONS).toMatch(/note to editor \(not printed\)" are advice for Bader/);
    expect(INSTRUCTIONS).toMatch(/Do not replace the list with a summary/);
  });
});
