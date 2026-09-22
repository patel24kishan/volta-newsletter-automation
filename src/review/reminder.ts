/**
 * The monthly reminder's words, built in code rather than left to a prompt, so what Bader reads on
 * the first workday is the same every month: the counts per group, what is pre-ticked, and every
 * thing that needs his attention (a source that came back empty or failed, an item on hold) with
 * the labels exactly as the list shows them.
 *
 * The reminder is triggered by a scheduled task in the Claude app. The tool that calls this decides
 * whether anything is due (src/schedule/scheduler.ts, whatIsDue) and makes sure Bader is greeted
 * once per period; this file only says what the greeting says.
 */
import { partsInZone } from "../clock.js";
import type { Cadence } from "../config.js";
import type { FirstWorkday } from "../schedule/first-workday.js";
import { REVIEW_LABEL } from "../surface/blocks.js";
import type { CandidateGroups } from "./review.js";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "October" for a monthly period (2026-10); "the week of Monday 21 September" for a weekly one. */
export function periodName(periodKey: string, cadence: Cadence): string {
  const [y, m, d] = periodKey.split("-").map(Number);
  if (cadence === "monthly") return MONTHS[m! - 1]!;
  return `the week of ${d} ${MONTHS[m! - 1]} ${y}`;
}

function greetingFor(now: Date, timeZone: string): string {
  const h = partsInZone(now, timeZone).hour;
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

function dayName(fw: FirstWorkday): string {
  const [, m, d] = fw.date.split("-").map(Number);
  return `${fw.weekday.charAt(0).toUpperCase()}${fw.weekday.slice(1)} ${d} ${MONTHS[m! - 1]}`;
}

export interface ReminderFacts {
  now: Date;
  timeZone: string;
  cadence: Cadence;
  periodKey: string;
  firstWorkday: FirstWorkday;
  reminderTime: string;
  /** Sent more than an hour after it was due (the computer was off, for example). */
  late: boolean;
  groups: CandidateGroups;
  ticked: string[];
  /** "news-volta: empty", "volta-linkedin: failed (...)", as the run recorded them. */
  sourceNotes: string[];
}

/** The first-workday greeting: what is ready, what is ticked, and what needs a look. */
export function greetingText(f: ReminderFacts): string {
  const name = periodName(f.periodKey, f.cadence);
  const all = [...f.groups.upcomingEvents, ...f.groups.pastEvents, ...f.groups.other];
  const ticked = new Set(f.ticked);
  const tickedTitles = all.filter((c) => ticked.has(c.item.id)).map((c) => c.item.title);
  const held = all.filter((c) => c.item.requires_review);
  const attention = [
    ...f.sourceNotes.map((n) => `- ${describeSourceNote(n)}`),
    ...held.map((c) => `- ${REVIEW_LABEL} · ${c.item.title.replace(/[.\s]+$/, "")}${c.item.hold_note ? `. On hold: ${c.item.hold_note}` : ""}${ticked.has(c.item.id) ? " (ticked)" : " (not ticked)"}`),
  ];
  const which = f.cadence === "monthly" ? `${name}'s newsletter` : `The newsletter for ${name}`;
  const opening = `${greetingFor(f.now, f.timeZone)} Bader. ${which} is prepared.${f.late ? ` This reminder is late: it was due ${dayName(f.firstWorkday)} at ${f.reminderTime}.` : ""}`;
  return [
    opening,
    "",
    `- Upcoming events: ${f.groups.upcomingEvents.length}`,
    ...(f.cadence === "monthly" ? [`- Last month's events: ${f.groups.pastEvents.length}`] : []),
    `- News and updates: ${f.groups.other.length}`,
    `- Pre-ticked: ${tickedTitles.length}${tickedTitles.length ? `: ${tickedTitles.join("; ")}` : ""}`,
    "",
    "Needs your attention:",
    ...(attention.length ? attention : ["Nothing needs attention."]),
    "",
    // The reminder runs as a scheduled task, which cannot show the review panel; a normal chat can.
    `To review it, open a new chat and say: "Show me ${name}'s newsletter." You'll get the list with checkboxes, and can tick items, change wording, add events and build the draft there.`,
  ].join("\n");
}

/** A source note in plain words: "news-volta: empty" reads as "news-volta found nothing this time". */
function describeSourceNote(note: string): string {
  const m = /^([^:]+): (empty|failed|skipped)(?: \((.*)\))?$/.exec(note);
  if (!m) return note;
  const [, id, status, detail] = m;
  if (status === "empty") return `${id} found nothing this time.`;
  if (status === "failed") return `${id} could not be read${detail ? `: ${detail}` : ""}.`;
  return `${id} was skipped${detail ? `: ${detail}` : ""}.`;
}

/** Said once, when a period passed with no reminder at all (the computer was off all week, say). */
export function missedText(f: Pick<ReminderFacts, "cadence" | "periodKey" | "firstWorkday" | "reminderTime">): string {
  const name = periodName(f.periodKey, f.cadence);
  return `Bader, the reminder for ${name}'s newsletter was due ${dayName(f.firstWorkday)} at ${f.reminderTime} and could not be shown in time, so it has stopped trying. Nothing was sent. You can still prepare it now by asking "prepare this month's newsletter".`;
}

/** Why nothing is said today, for the task's log. Never shown to Bader. */
export function nothingDueText(f: Pick<ReminderFacts, "cadence" | "periodKey" | "firstWorkday" | "reminderTime">, reason: "not-yet" | "already-greeted" | "closed" | "missed-already-said"): string {
  const name = periodName(f.periodKey, f.cadence);
  switch (reason) {
    case "not-yet": return `${name}'s newsletter is due ${dayName(f.firstWorkday)} at ${f.reminderTime}.`;
    case "already-greeted": return `Bader was already reminded about ${name}'s newsletter.`;
    case "closed": return `Volta is closed every workday of ${name}; there is no newsletter.`;
    case "missed-already-said": return `${name}'s reminder was missed, and Bader has already been told.`;
  }
}
