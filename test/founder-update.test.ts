import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryAlerter } from "../src/alerts.js";
import { resolveClock } from "../src/clock.js";
import type { Config, SourceConfig } from "../src/config.js";
import { buildDrafts } from "../src/draft/templates.js";
import { SlackChannelFetcher, parseFounderUpdate, splitEditorial } from "../src/fetchers/slack-channel.js";
import { rankItems } from "../src/pipeline/rank.js";
import { runWeek } from "../src/run-week.js";
import { validateItem } from "../src/schema.js";
import { SqliteStorage } from "../src/storage.js";

// Shapes copied from the real #newsletter-keynotes channel (entities as Slack sends them).
const NORMAL = [
  ":studio_microphone: *Northcast · Iris Thibodeau, founder · Fri, Sep 11, 2026*",
  "",
  "Open beta of the fisheries weather API. 21 min, recorded.",
  "",
  "*Conversation*",
  "",
  "*Q (3:00): Why an API and not an app?*",
  "&gt; Because the app already exists — four of them, and they're all fine.",
  "*Summary*",
  "• Open beta of a hyperlocal marine forecast API — 6 km resolution versus Environment Canada's much larger marine zones.",
  "• Claims improvement on *wind direction only*; explicitly says wave height is no better. Comparison data promised — chase it, and don't publish the claim without it.",
  "• Public docs, free tier, no card required.",
  "• *Newsletter angle:* \"one forecast for an area where the wind differs end to end\" is the line that makes the problem legible.",
  "• Ask Iris for the comparison chart. *Sent using* Claude",
].join("\n");

const FUNDING = [
  ":studio_microphone: *Harbourlight Robotics · Nadia Fortin, CEO · Wed, Sep 2, 2026*",
  "",
  "Seed round closed. 26 min, recorded.",
  "",
  "*Summary*",
  "• Closed a $1.4M seed, led out of Montréal with two local angels. Nadia explicitly asked that the raise amount not lead.",
  "• Quotable: _\"'The market is too small' often means 'I don't know this market.'\"_ Confirmed she's happy for this to be used.",
  "• *Newsletter angle:* run it as the rejection story. *Sent using* Claude",
].join("\n");

const EMBARGO = [
  ":hourglass_flowing_sand: *HOLD — REVISIT w/c Sep 28 (embargo)*",
  ":studio_microphone: *Bellwether Soil · Marc Comeau, co-founder · Tue, Sep 15, 2026*",
  "",
  "Good material, can't run it yet. 24 min, recorded.",
  "",
  "*Conversation*",
  "",
  "*Q (4:15): You said on the phone there's news but you can't tell me.*",
  "&gt; I can tell you, you just can't print it until the thirtieth.",
  "*Summary*",
  "• Federal agri-innovation grant confirmed, *embargoed until Sep 30* — announcement is the funder's to make.",
  "• Non-embargoed material is solid: 11 farms, 2 seasons of data.",
  "• Marc's framing of the grant as runway is a better quote than the grant itself.",
  "*Why it's held*",
  "Embargo, not editorial.",
  "",
  "*Revisit at end of month*",
  "→ Confirm the announcement went ahead on Sep 30 before publishing anything. *Sent using* Claude",
].join("\n");

const HELD_NOT_READY = EMBARGO
  .replace("HOLD — REVISIT w/c Sep 28 (embargo)", "HOLD — REVISIT w/c Sep 28")
  .replace("Bellwether Soil · Marc Comeau, co-founder · Tue, Sep 15, 2026", "Kelpwise · Jonah Mercer, founder · Fri, Sep 4, 2026");

describe("parseFounderUpdate", () => {
  it("reads company, person, date, topic and the newsletter angle", () => {
    const u = parseFounderUpdate(NORMAL)!;
    expect(u).toMatchObject({ company: "Northcast", person: "Iris Thibodeau, founder", dateText: "Fri, Sep 11, 2026" });
    // The duration note after the first sentence is metadata, not the topic.
    expect(u.topic).toBe("Open beta of the fisheries weather API.");
    expect(u.hold).toBeUndefined();
    expect(u.bullets).toHaveLength(5);
    expect(u.angle).toMatch(/^"one forecast for an area/);
    expect(u.bullets.join(" ")).not.toMatch(/\*|Sent using/);
  });

  it("splits what a reader can be told from what was said to the editor, and loses neither", () => {
    const u = parseFounderUpdate(NORMAL)!;
    expect(u.insights).toEqual([
      "Open beta of a hyperlocal marine forecast API — 6 km resolution versus Environment Canada's much larger marine zones.",
      "Claims improvement on wind direction only; explicitly says wave height is no better.",
      "Public docs, free tier, no card required.",
    ]);
    // The angle, the bullet after it, and the caution lifted out of bullet two.
    expect(u.notes).toEqual([
      "Ask Iris for the comparison chart.",
      "Comparison data promised — chase it, and don't publish the claim without it.",
    ]);
    expect(u.insights.join(" ")).not.toMatch(/don't publish|chase it|Newsletter angle/);
  });

  it("keeps a decimal figure and a quotation whole (regression: \"$1.4M\" once came out as \"4M\")", () => {
    const u = parseFounderUpdate(FUNDING)!;
    expect(u.insights[0]).toBe("Closed a $1.4M seed, led out of Montréal with two local angels.");
    expect(u.insights[1]).toBe("\"'The market is too small' often means 'I don't know this market.'\"");
    expect(u.notes).toContain("Confirmed she's happy for this to be used.");
    // A selector cannot obey "don't lead with the raise", so the instruction goes to the curator.
    expect(u.notes).toContain("Nadia explicitly asked that the raise amount not lead.");
  });

  it("recognises a hold, with or without an embargo, and turns its closing sections into notes", () => {
    const e = parseFounderUpdate(EMBARGO)!;
    expect(e.hold).toBe("REVISIT w/c Sep 28 (embargo)");
    expect(e.company).toBe("Bellwether Soil");
    expect(e.bullets).toHaveLength(3); // "Why it's held" is not a bullet
    expect(e.angle).toBeUndefined();
    expect(e.notes).toEqual([
      "Why it's held: Embargo, not editorial.",
      "Revisit at end of month: Confirm the announcement went ahead on Sep 30 before publishing anything.",
    ]);
    expect(parseFounderUpdate(HELD_NOT_READY)!.hold).toBe("REVISIT w/c Sep 28");
  });

  it("returns undefined for anything that is not a founder update", () => {
    expect(parseFounderUpdate("nice work everyone!")).toBeUndefined();
    expect(parseFounderUpdate("Proud to share <https://cbc.ca/story|CBC story>")).toBeUndefined();
    expect(parseFounderUpdate(":studio_microphone: *Only Two · Parts*")).toBeUndefined();
  });
});

describe("splitEditorial", () => {
  it("never discards a sentence: each one is either kept or moved to the notes", () => {
    const bullet = "Crossed 100 paying customers. That's the story. Flag this for legal before we run it.";
    const { keep, editorial } = splitEditorial(bullet);
    expect(keep).toBe("Crossed 100 paying customers.");
    expect(editorial).toEqual(["That's the story.", "Flag this for legal before we run it."]);
    expect(`${keep} ${editorial.join(" ")}`).toBe(bullet);
  });
});

const source: SourceConfig = { id: "member-updates", kind: "slack_channel", type: "member_social", url: "", enabled: true, channel_id: "C0C2H7WAUJX" };
const config: Config = {
  timezone: "America/Halifax", draft_layout: "events-first", send_day: "monday", reminder_time: "08:30", content_window_days: 7, events_window_days: 14,
  watchlist: ["Volta"], holiday_overrides: [], alert_recipients: [], sources: [source],
};
const clock = resolveClock(["--now=2026-09-17T23:00:00Z"], {});
const ts = (iso: string) => `${Math.floor(Date.parse(iso) / 1000)}.496229`;

function slack(messages: Array<{ text: string; ts: string }>, opts: { permalinkFails?: boolean } = {}) {
  const calls: string[] = [];
  const fn = async (method: string, params: Record<string, string>) => {
    calls.push(method);
    if (method === "chat.getPermalink") {
      return opts.permalinkFails ? { ok: false, error: "message_not_found" } : { ok: true, permalink: `https://ghost24.slack.com/archives/${params.channel}/p${params.message_ts!.replace(".", "")}` };
    }
    return { ok: true, messages: messages.map((m) => ({ type: "message", user: "U0C1XBRT421", ...m })) };
  };
  return { fn, calls };
}

describe("founder updates through the channel fetcher", () => {
  const fetcher = new SlackChannelFetcher();
  const env = { SLACK_BOT_TOKEN: "xoxb-test" };

  it("a clear update: reader-facing title, angle as the choosing line, insights and notes kept apart, linked to the message", async () => {
    const t = ts("2026-09-17T20:00:00Z");
    const { fn, calls } = slack([{ text: NORMAL, ts: t }]);
    const r = await fetcher.fetch(source, { config, clock, slackApi: fn, env });

    expect(r.error).toBeUndefined();
    const item = r.items[0]!;
    expect(validateItem(item)).toEqual({ ok: true, errors: [] });
    expect(item).toMatchObject({
      type: "member_social",
      title: "Northcast: Open beta of the fisheries weather API.",
      byline: "Iris Thibodeau, founder",
      needs_summary: false,
      requires_review: false,
      link: `https://ghost24.slack.com/archives/C0C2H7WAUJX/p${t.replace(".", "")}`,
    });
    expect(item.summary).toMatch(/^"one forecast for an area/);
    // The newsletter gets a condensed entry, not the write-up: two single-sentence points.
    expect(item.insights).toEqual([
      "Open beta of a hyperlocal marine forecast API — 6 km resolution versus Environment Canada's much larger marine zones.",
      "Claims improvement on wind direction only; explicitly says wave height is no better.",
    ]);
    expect(item.editor_notes).toHaveLength(2);
    expect(item.hold_note).toBeUndefined();
    // No submitter lookup is needed: the header already names who the update is about.
    expect(calls).toEqual(["conversations.history", "chat.getPermalink"]);
  });

  it("a held update is shown, flagged for a human, and carries why it is held. Its title stays reader-facing", async () => {
    const { fn } = slack([{ text: EMBARGO, ts: ts("2026-09-15T20:00:00Z") }]);
    const item = (await fetcher.fetch(source, { config, clock, slackApi: fn, env })).items[0]!;

    // The review label belongs to Slack. If it were baked into the title it would reach readers.
    expect(item.title).toBe("Bellwether Soil: Good material, can't run it yet.");
    expect(item.requires_review).toBe(true);
    expect(item.hold_note).toBe("REVISIT w/c Sep 28 (embargo)");
    // While choosing, a held item is described by its first two points.
    expect(item.summary).toBe("Federal agri-innovation grant confirmed, embargoed until Sep 30 — announcement is the funder's to make. Non-embargoed material is solid: 11 farms, 2 seasons of data.");
    expect(item.editor_notes!.join(" ")).toMatch(/Confirm the announcement went ahead on Sep 30/);
    expect(item.link).toMatch(/^https:\/\/ghost24\.slack\.com\/archives\/C0C2H7WAUJX\/p\d+$/);
    expect(validateItem(item).ok).toBe(true);
  });

  it("a held update ranks below a clear one posted the same day", async () => {
    const { fn } = slack([{ text: EMBARGO, ts: ts("2026-09-17T20:00:00Z") }, { text: NORMAL, ts: ts("2026-09-17T19:00:00Z") }]);
    const items = (await fetcher.fetch(source, { config, clock, slackApi: fn, env })).items;
    const ranked = rankItems(items, clock.now());
    expect(ranked[0]!.item.title).toMatch(/^Northcast/);
    expect(ranked[1]!.item.requires_review).toBe(true);
    expect(ranked[1]!.reasons.join()).toMatch(/requires review -2/);
  });

  it("never invents a link: if Slack gives no permalink the update is skipped and a warning says so", async () => {
    const { fn } = slack([{ text: NORMAL, ts: ts("2026-09-17T20:00:00Z") }], { permalinkFails: true });
    const r = await fetcher.fetch(source, { config, clock, slackApi: fn, env });
    expect(r.items).toEqual([]);
    expect(r.warnings.join()).toMatch(/could not get a permalink for the Northcast update/);
  });

  it("handles updates and plain link-shares in the same channel", async () => {
    const { fn } = slack([
      { text: NORMAL, ts: ts("2026-09-17T20:00:00Z") },
      { text: "We were on CBC this morning <https://cbc.ca/story>", ts: ts("2026-09-16T12:00:00Z") },
      { text: "congrats all!", ts: ts("2026-09-16T11:00:00Z") },
    ]);
    const r = await fetcher.fetch(source, { config, clock, slackApi: fn, env });
    expect(r.items.map((i) => i.link)).toEqual([expect.stringContaining("ghost24.slack.com/archives"), "https://cbc.ca/story"]);
    expect(r.warnings.join()).toMatch(/1 message\(s\) had no link/);
  });
});

describe("held updates and the pre-generated drafts", () => {
  it("on a quiet week a held update is still listed but never pre-selected or drafted", async () => {
    // Only two candidates, so ranking alone would put both in the top ten.
    const { fn } = slack([{ text: EMBARGO, ts: ts("2026-09-17T20:00:00Z") }, { text: NORMAL, ts: ts("2026-09-17T19:00:00Z") }]);
    const outDir = mkdtempSync(join(tmpdir(), "volta-held-"));
    const storage = new SqliteStorage(":memory:");
    try {
      const run = await runWeek({ config, clock, storage, alerter: new MemoryAlerter(), outDir, slackApi: fn, env: { SLACK_BOT_TOKEN: "x" } });

      expect(run.candidates.map((c) => c.item.title)).toEqual([
        "Northcast: Open beta of the fisheries weather API.",
        "Bellwether Soil: Good material, can't run it yet.",
      ]);
      const held = run.candidates.find((c) => c.item.requires_review)!;
      expect(run.preselected_ids).not.toContain(held.item.id);
      expect(run.preselected_ids).toHaveLength(1);

      // The embargoed grant must not appear anywhere in what was drafted automatically.
      for (const d of run.drafts) {
        const md = readFileSync(d.file_md, "utf8");
        expect(md, d.id).not.toContain("Bellwether");
        expect(md, d.id).not.toContain("embargo");
        expect(md, d.id).toContain("Northcast");
      }
      // Insights, notes and the hold note survive storage.
      expect(storage.getItem(held.item.id)).toMatchObject({ hold_note: "REVISIT w/c Sep 28 (embargo)", byline: "Marc Comeau, co-founder" });
      expect(storage.getItem(held.item.id)!.insights).toHaveLength(2);
    } finally {
      storage.close();
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});

describe("founder updates in the drafts", () => {
  it("appear under Key insights as bullets, with nothing meant for the editor and no review label", async () => {
    const { fn } = slack([{ text: NORMAL, ts: ts("2026-09-17T20:00:00Z") }, { text: EMBARGO, ts: ts("2026-09-15T20:00:00Z") }, { text: FUNDING, ts: ts("2026-09-14T20:00:00Z") }]);
    const items = (await new SlackChannelFetcher().fetch(source, { config, clock, slackApi: fn, env: { SLACK_BOT_TOKEN: "x" } })).items;
    const drafts = buildDrafts(items, { timeZone: config.timezone });

    for (const d of drafts) {
      expect(d.verification.violations, `${d.id}: ${JSON.stringify(d.verification.violations)}`).toEqual([]);
      // What readers must never see: the curator's label, the editor's angle, cautions, hold reasons.
      for (const leak of ["MARKED FOR REVIEW", "Newsletter angle", "don't publish", "chase it", "Why it's held", "REVISIT", "Confirmed she's happy", "Ask Iris"]) {
        expect(d.markdown, `${d.id} leaks "${leak}"`).not.toContain(leak);
        expect(d.html, `${d.id} html leaks "${leak}"`).not.toContain(leak);
      }
    }

    const standard = drafts[1]!;
    expect(standard.markdown).toContain("## Key insights");
    expect(standard.markdown).toContain("**Northcast: Open beta of the fisheries weather API.**");
    expect(standard.markdown).toContain("With Iris Thibodeau, founder");
    expect(standard.markdown).toContain("- Claims improvement on wind direction only; explicitly says wave height is no better.");
    expect(standard.markdown).toContain("- Closed a $1.4M seed, led out of Montréal with two local angels.");
    // The Slack permalink is for Bader's candidate list, not for a subscriber who cannot open it.
    expect(standard.markdown).not.toContain("ghost24.slack.com");
    expect(standard.html).not.toContain("ghost24.slack.com");
    expect(standard.html).toMatch(/<li[^>]*>Open beta of a hyperlocal marine forecast API/);
    // A held item that a person chose reads like any other story.
    expect(standard.markdown).toContain("**Bellwether Soil: Good material, can't run it yet.**");

    // Standard leads with the stories; Events first leads with the calendar. Brief gives one point each.
    expect(standard.markdown.indexOf("## Key insights")).toBeLessThan(standard.markdown.indexOf("## Upcoming events"));
    const eventsFirst = drafts[2]!.markdown;
    expect(eventsFirst.indexOf("## Upcoming events")).toBeLessThan(eventsFirst.indexOf("## Key insights"));
    const brief = drafts[0]!.markdown;
    expect(brief).toContain("- Open beta of a hyperlocal marine forecast API");
    expect(brief).not.toContain("- Public docs, free tier");

    // An entry is a summary, not the write-up: at most two points and a bounded length.
    // (Copying every bullet once made eight updates into 640 of a draft's 767 words.)
    const section = standard.markdown.split("## Key insights")[1]!.split(/\n## /)[0]!;
    const entries = section.split(/\n(?=\*\*)/).filter((e) => e.trim().startsWith("**"));
    expect(entries).toHaveLength(3);
    for (const entry of entries) {
      expect(entry.split("\n").filter((l) => l.startsWith("- ")).length, entry.slice(0, 40)).toBeLessThanOrEqual(2);
      expect(entry.split(/\s+/).filter(Boolean).length, entry.slice(0, 40)).toBeLessThanOrEqual(70);
    }

    // Nothing of theirs is filed under another source's heading.
    for (const heading of ["## In the news", "## From Volta on LinkedIn"]) {
      expect(standard.markdown.split(heading)[1]!.split("## ")[0]!, heading).not.toContain("Northcast");
    }
  });
});
