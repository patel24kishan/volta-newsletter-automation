/**
 * Phase 3: the words of the monthly reminder, built in code so they are the same every month.
 */
import { describe, expect, it } from "vitest";
import { rankItems } from "../src/pipeline/rank.js";
import { greetingText, missedText, nothingDueText, periodName, type ReminderFacts } from "../src/review/reminder.js";
import { candidateGroups } from "../src/review/review.js";
import { sampleItem } from "./helpers.js";

const TZ = "America/Halifax";
const NOW = new Date("2026-10-01T11:40:00Z"); // 08:40 in Halifax
const fw = { date: "2026-10-01", weekday: "thursday", weekMonday: "2026-09-28", skipped: [] };

const mixer = sampleItem({ type: "event", source: "volta-calendar", link: "https://e.test/mixer", title: "Fall Mixer", date: "2026-10-22T21:00:00Z", event_timing: "upcoming" });
const demo = sampleItem({ type: "event", source: "volta-calendar", link: "https://e.test/demo", title: "Demo Night", date: "2026-09-17T22:00:00Z", event_timing: "past" });
const story = sampleItem({ link: "https://news.test/a", title: "Volta launches a program" });
const held = sampleItem({ type: "member_social", source: "member-updates", link: "https://volta.slack.com/p1", title: "Bellwether Soil: Good material, can't run it yet.", requires_review: true, hold_note: "REVISIT w/c Sep 28 (embargo)" });

function facts(o: Partial<ReminderFacts> = {}): ReminderFacts {
  const candidates = rankItems([mixer, demo, story, held], NOW);
  return {
    now: NOW, timeZone: TZ, cadence: "monthly", periodKey: "2026-10", firstWorkday: fw, reminderTime: "08:30", late: false,
    groups: candidateGroups({ candidates }), ticked: [mixer.id, story.id], sourceNotes: [], ...o,
  };
}

describe("the first-workday greeting", () => {
  it("names the month, counts each group and lists what is pre-ticked", () => {
    const t = greetingText(facts());
    expect(t.split("\n")[0]).toBe("Good morning Bader. October's newsletter is prepared.");
    expect(t).toContain("- Upcoming events: 1\n- Last month's events: 1\n- News and updates: 2");
    expect(t).toContain("- Pre-ticked: 2: Fall Mixer; Volta launches a program");
    // Bader is sent to a normal chat, where the review panel opens.
    expect(t.split("\n").at(-1)).toBe("To review it, open a new chat and say: \"Show me October's newsletter.\" You'll get the list with checkboxes, and can tick items, change wording, add events and build the draft there.");
  });

  it("lists every source that needs a look, and every held item with its label and reason", () => {
    const t = greetingText(facts({ sourceNotes: ["news-volta: empty", "volta-linkedin: failed (LinkedIn served a login wall)"] }));
    expect(t).toContain("Needs your attention:\n- news-volta found nothing this time.\n- volta-linkedin could not be read: LinkedIn served a login wall.");
    expect(t).toContain("- MARKED FOR REVIEW · Bellwether Soil: Good material, can't run it yet. On hold: REVISIT w/c Sep 28 (embargo) (not ticked)");
  });

  it("keeps a held title's own last letter, dropping only a trailing full stop", () => {
    const robotics = sampleItem({ link: "https://volta.slack.com/p2", title: "Harbourlight Robotics", requires_review: true, hold_note: "embargo" });
    const t = greetingText(facts({ groups: candidateGroups({ candidates: rankItems([robotics], NOW) }), ticked: [] }));
    expect(t).toContain("- MARKED FOR REVIEW · Harbourlight Robotics. On hold: embargo (not ticked)");
  });

  it("says so when nothing needs attention", () => {
    const candidates = rankItems([mixer, story], NOW);
    const t = greetingText(facts({ groups: candidateGroups({ candidates }) }));
    expect(t).toContain("Needs your attention:\nNothing needs attention.");
  });

  it("owns up to being late, and suits the time of day", () => {
    const t = greetingText(facts({ late: true, now: new Date("2026-10-05T18:00:00Z") })); // 15:00 in Halifax
    expect(t.split("\n")[0]).toBe("Good afternoon Bader. October's newsletter is prepared. This reminder is late: it was due Thursday 1 October at 08:30.");
    expect(greetingText(facts({ now: new Date("2026-10-01T22:00:00Z") })).startsWith("Good evening")).toBe(true);
  });

  it("has no look back for a weekly newsletter", () => {
    const t = greetingText(facts({ cadence: "weekly", periodKey: "2026-09-28" }));
    expect(t.split("\n")[0]).toBe("Good morning Bader. The newsletter for the week of 28 September 2026 is prepared.");
    expect(t).not.toContain("Last month's events");
  });
});

describe("the other answers", () => {
  it("tells Bader once, plainly, when a month's reminder was missed", () => {
    expect(missedText({ cadence: "monthly", periodKey: "2026-10", firstWorkday: fw, reminderTime: "08:30" }))
      .toBe('Bader, the reminder for October\'s newsletter was due Thursday 1 October at 08:30 and could not be shown in time, so it has stopped trying. Nothing was sent. You can still prepare it now by asking "prepare this month\'s newsletter".');
  });

  it("explains a quiet day, for the task's log", () => {
    const f = { cadence: "monthly" as const, periodKey: "2026-10", firstWorkday: fw, reminderTime: "08:30" };
    expect(nothingDueText(f, "not-yet")).toBe("October's newsletter is due Thursday 1 October at 08:30.");
    expect(nothingDueText(f, "already-greeted")).toBe("Bader was already reminded about October's newsletter.");
    expect(periodName("2027-07", "monthly")).toBe("July");
  });
});
