/**
 * M3a: past and upcoming events are told apart when fetched and kept apart after that: in the
 * ranking, in the pre-ticked set, in the groups Claude shows the curator, and in the newsletter.
 */
import { describe, expect, it } from "vitest";
import { resolveClock } from "../src/clock.js";
import type { Config, SourceConfig } from "../src/config.js";
import { buildDrafts } from "../src/draft/templates.js";
import { IcsFetcher } from "../src/fetchers/ics.js";
import { ManualEventsFetcher } from "../src/fetchers/manual.js";
import { rankItems } from "../src/pipeline/rank.js";
import { candidateGroups } from "../src/review/review.js";
import { isPastEvent, validateItem } from "../src/schema.js";
import { SqliteStorage } from "../src/storage.js";
import { sampleItem } from "./helpers.js";

const TZ = "America/Halifax";
const RUN = new Date("2026-10-01T11:30:00Z"); // 08:30 in Halifax on the first workday of October
const clock = resolveClock(["--now=2026-10-01T11:30:00Z"], {});
const cfg = (cadence: NonNullable<Config["cadence"]>): Config => ({
  timezone: TZ, draft_layout: "events-first", send_day: "monday", reminder_time: "08:30", content_window_days: 7, events_window_days: 14,
  watchlist: ["Volta"], holiday_overrides: [], alert_recipients: [], sources: [], cadence,
});

const pastEvent = (title: string, date: string) => sampleItem({
  type: "event", source: "volta-calendar", link: `https://e.test/${encodeURIComponent(title)}`, title, date,
  summary: `${title} brought founders together.`, raw_excerpt: `${title} ${title} brought founders together.`, location: "Volta", event_timing: "past",
});
const upcomingEvent = (title: string, date: string) => sampleItem({
  type: "event", source: "volta-calendar", link: `https://e.test/${encodeURIComponent(title)}`, title, date,
  summary: `${title} for the fall cohort.`, raw_excerpt: `${title} ${title} for the fall cohort.`, location: "Volta", event_timing: "upcoming",
});
const demo = pastEvent("Demo Night", "2026-09-17T22:00:00Z");
const summit = pastEvent("Summer Summit", "2026-09-03T18:00:00Z");
const mixer = upcomingEvent("Fall Mixer", "2026-10-22T21:00:00Z");
const workshop = upcomingEvent("Pitch Workshop", "2026-10-08T21:00:00Z");
const story = sampleItem({ link: "https://news.test/a", title: "Volta launches a program" });

describe("marking events when fetched", () => {
  const CRLF = "\r\n";
  const vevent = (uid: string, start: string, end = start) =>
    ["BEGIN:VEVENT", `UID:${uid}`, `SUMMARY:${uid}`, `DTSTART:${start}`, `DTEND:${end}`, `URL:https://x.test/${uid}`, "END:VEVENT"].join(CRLF);
  const body = ["BEGIN:VCALENDAR", "VERSION:2.0",
    vevent("held", "20260917T220000Z"),
    vevent("in-progress", "20260930T200000Z", "20261002T200000Z"),
    vevent("coming", "20261022T210000Z"),
    "END:VCALENDAR"].join(CRLF);
  const ics: SourceConfig = { id: "volta-calendar", kind: "ics", type: "event", url: "https://cal.test/ics", enabled: true };

  it("the calendar marks held events past, and coming or still running ones upcoming", async () => {
    const r = await new IcsFetcher().fetch(ics, { config: cfg("monthly"), clock, fetchText: async () => body });
    const timing = Object.fromEntries(r.items.map((i) => [i.title, i.event_timing]));
    expect(timing).toEqual({ held: "past", "in-progress": "upcoming", coming: "upcoming" });
    for (const i of r.items) expect(validateItem(i).ok).toBe(true);
  });

  it("a weekly run only ever marks events upcoming", async () => {
    const r = await new IcsFetcher().fetch(ics, { config: cfg("weekly"), clock, fetchText: async () => body });
    expect(r.items.every((i) => i.event_timing === "upcoming")).toBe(true);
  });

  it("manually added events are marked the same way", async () => {
    const storage = new SqliteStorage(":memory:");
    try {
      storage.addManualEvent({ title: "Held one", starts_at: "2026-09-18T22:00:00.000Z", location: "", description: "", link: "" });
      storage.addManualEvent({ title: "Coming one", starts_at: "2026-10-22T22:00:00.000Z", location: "", description: "", link: "" });
      const source: SourceConfig = { id: "manual-events", kind: "manual", type: "event", url: "", enabled: true, fallback_link: "https://voltaeffect.com/events" };
      const r = await new ManualEventsFetcher().fetch(source, { config: cfg("monthly"), clock, storage });
      expect(Object.fromEntries(r.items.map((i) => [i.title, i.event_timing]))).toEqual({ "Held one": "past", "Coming one": "upcoming" });
    } finally {
      storage.close();
    }
  });

  it("is kept when saved and read back, and rejects anything but past or upcoming", () => {
    const storage = new SqliteStorage(":memory:");
    try {
      storage.upsertItems([demo]);
      expect(storage.getItem(demo.id)!.event_timing).toBe("past");
    } finally {
      storage.close();
    }
    expect(validateItem({ ...demo, event_timing: "soon" }).errors).toContain("event_timing must be past or upcoming when present");
  });

  it("an event from before this field existed counts as upcoming", () => {
    const legacy = { ...mixer };
    delete legacy.event_timing;
    expect(isPastEvent(legacy)).toBe(false);
    expect(isPastEvent({ type: "news", event_timing: "past", date: "2026-09-01T00:00:00.000Z" })).toBe(false);
  });
});

describe("the curator's list", () => {
  it("never ranks an event already held above one still to come", () => {
    const ranked = rankItems([demo, mixer], RUN);
    expect(ranked.map((r) => r.item.title)).toEqual(["Fall Mixer", "Demo Night"]);
    expect(ranked[1]!.reasons.join()).toMatch(/held 14d ago \+0/);
  });

  it("groups upcoming events soonest first, past events most recent first, then everything else", () => {
    const g = candidateGroups({ candidates: rankItems([summit, story, mixer, demo, workshop], RUN) });
    expect(g.upcomingEvents.map((c) => c.item.title)).toEqual(["Pitch Workshop", "Fall Mixer"]);
    expect(g.pastEvents.map((c) => c.item.title)).toEqual(["Demo Night", "Summer Summit"]);
    expect(g.other.map((c) => c.item.title)).toEqual(["Volta launches a program"]);
  });
});

describe("the newsletter", () => {
  it("prints past events in their own section, after the upcoming ones, in every layout", () => {
    for (const d of buildDrafts([demo, mixer, story], { timeZone: TZ })) {
      const md = d.markdown;
      expect(d.verification.ok, d.id).toBe(true);
      const upcomingAt = md.indexOf("## Upcoming events");
      const pastAt = md.indexOf("## Last month at Volta");
      expect(upcomingAt, d.id).toBeGreaterThanOrEqual(0);
      expect(pastAt, d.id).toBeGreaterThan(upcomingAt);
      // Each event sits under its own heading and nowhere else (the subject line above both can
      // name the top item, so only the body is searched).
      const body = md.slice(upcomingAt);
      const up = body.indexOf("## Upcoming events");
      const past = body.indexOf("## Last month at Volta");
      expect(body.indexOf("Fall Mixer"), d.id).toBeGreaterThan(up);
      expect(body.lastIndexOf("Fall Mixer"), d.id).toBeLessThan(past);
      expect(body.indexOf("Demo Night"), d.id).toBeGreaterThan(past);
      expect(md, d.id).toMatch(/Held:? Thursday, September 17, 7:00 pm/);
    }
  });

  it("says when an upcoming event is, with When, and never Held", () => {
    const md = buildDrafts([mixer], { timeZone: TZ, layouts: ["standard"] })[0]!.markdown;
    expect(md).toContain("When: Thursday, October 22, 6:00 pm");
    expect(md).not.toContain("Held");
  });

  it("leaves the look back out when no past event was chosen", () => {
    for (const d of buildDrafts([mixer, story], { timeZone: TZ })) expect(d.markdown, d.id).not.toContain("Last month at Volta");
  });

  it("with only past events chosen, says there are no upcoming ones rather than inventing any", () => {
    const md = buildDrafts([demo], { timeZone: TZ, layouts: ["events-first"] })[0]!.markdown;
    expect(md).toContain("No upcoming events this week.");
    expect(md).toContain("## Last month at Volta");
  });
});
