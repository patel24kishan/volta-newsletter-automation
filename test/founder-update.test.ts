import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryAlerter } from "../src/alerts.js";
import { runWeek } from "../src/run-week.js";
import { SqliteStorage } from "../src/storage.js";
import { resolveClock } from "../src/clock.js";
import type { Config, SourceConfig } from "../src/config.js";
import { buildDrafts } from "../src/draft/templates.js";
import { SlackChannelFetcher, parseFounderUpdate } from "../src/fetchers/slack-channel.js";
import { rankItems } from "../src/pipeline/rank.js";
import { validateItem } from "../src/schema.js";

// Shapes copied from the real #newsletter-keynotes channel (entities as Slack sends them).
const NORMAL = [
  ":studio_microphone: *Lantern Freight · Yuki Tanaka, co-founder · Thu, Sep 17, 2026*",
  "",
  "Three hires and a metric they're proud of. 23 min, recorded.",
  "",
  "*Conversation*",
  "",
  "*Q (1:45): You said you had a number you actually liked. Which one?*",
  "&gt; Empty-mile percentage. Trucks on our network run empty eighteen percent of the time.",
  "*Summary*",
  "• Headline metric: *18% empty miles versus a ~35% industry average.* Yuki volunteered the caveats.",
  "• Three new hires, all deliberately from outside logistics.",
  "• *Newsletter angle:* the metric gets people in, the hiring philosophy is what they'll remember. Run both, metric first.",
  "• Publish the empty-miles figure with his caveat attached, not as a bare number. *Sent using* Claude",
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
  it("reads company, person, date, topic, bullets and the newsletter angle", () => {
    const u = parseFounderUpdate(NORMAL)!;
    expect(u).toMatchObject({ company: "Lantern Freight", person: "Yuki Tanaka, co-founder", dateText: "Thu, Sep 17, 2026" });
    // The duration note after the first sentence is metadata, not the topic.
    expect(u.topic).toBe("Three hires and a metric they're proud of.");
    expect(u.hold).toBeUndefined();
    expect(u.bullets).toHaveLength(4);
    expect(u.angle).toBe("the metric gets people in, the hiring philosophy is what they'll remember. Run both, metric first.");
    // Emphasis markers and the tool's sign-off are presentation, not content.
    expect(u.bullets.join(" ")).not.toMatch(/\*|Sent using/);
  });

  it("recognises a hold, with or without an embargo, and stops bullets at the next section", () => {
    const e = parseFounderUpdate(EMBARGO)!;
    expect(e.hold).toBe("REVISIT w/c Sep 28 (embargo)");
    expect(e.company).toBe("Bellwether Soil");
    expect(e.bullets).toHaveLength(3); // "Why it's held" is not a bullet
    expect(e.angle).toBeUndefined();
    expect(parseFounderUpdate(HELD_NOT_READY)!.hold).toBe("REVISIT w/c Sep 28");
  });

  it("returns undefined for anything that is not a founder update", () => {
    expect(parseFounderUpdate("nice work everyone!")).toBeUndefined();
    expect(parseFounderUpdate("Proud to share <https://cbc.ca/story|CBC story>")).toBeUndefined();
    expect(parseFounderUpdate(":studio_microphone: *Only Two · Parts*")).toBeUndefined();
  });
});

const source: SourceConfig = { id: "member-updates", kind: "slack_channel", type: "member_social", url: "", enabled: true, channel_id: "C0C2H7WAUJX" };
const config: Config = {
  timezone: "America/Halifax", send_day: "monday", reminder_time: "08:30", content_window_days: 7, events_window_days: 14,
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

  it("a normal update becomes an item titled by company and topic, summarised by its newsletter angle, linked to the message", async () => {
    const t = ts("2026-09-17T20:00:00Z");
    const { fn, calls } = slack([{ text: NORMAL.replace(/&gt;/g, "&gt;"), ts: t }]);
    const r = await fetcher.fetch(source, { config, clock, slackApi: fn, env });

    expect(r.error).toBeUndefined();
    expect(r.items).toHaveLength(1);
    const item = r.items[0]!;
    expect(validateItem(item)).toEqual({ ok: true, errors: [] });
    expect(item).toMatchObject({
      type: "member_social",
      title: "Lantern Freight: Three hires and a metric they're proud of.",
      summary: "the metric gets people in, the hiring philosophy is what they'll remember. Run both, metric first.",
      needs_summary: false,
      requires_review: false,
      link: `https://ghost24.slack.com/archives/C0C2H7WAUJX/p${t.replace(".", "")}`,
    });
    // No submitter lookup is needed: the header already names who the update is about.
    expect(calls).toEqual(["conversations.history", "chat.getPermalink"]);
  });

  it("a held update is shown, not hidden: marked for review first, two bullets as the summary, and flagged for a human", async () => {
    const { fn } = slack([{ text: EMBARGO, ts: ts("2026-09-15T20:00:00Z") }]);
    const item = (await fetcher.fetch(source, { config, clock, slackApi: fn, env })).items[0]!;

    expect(item.title).toBe("MARKED FOR REVIEW: Bellwether Soil: Good material, can't run it yet.");
    expect(item.requires_review).toBe(true);
    expect(item.summary).toBe("Federal agri-innovation grant confirmed, embargoed until Sep 30 — announcement is the funder's to make. Non-embargoed material is solid: 11 farms, 2 seasons of data.");
    expect(item.raw_excerpt).toContain("HOLD — REVISIT w/c Sep 28 (embargo)");
    expect(item.link).toMatch(/^https:\/\/ghost24\.slack\.com\/archives\/C0C2H7WAUJX\/p\d+$/);
    expect(validateItem(item).ok).toBe(true);
  });

  it("a held update never seeds the pre-selected drafts ahead of a clear one posted the same day", async () => {
    const { fn } = slack([
      { text: EMBARGO, ts: ts("2026-09-17T20:00:00Z") },
      { text: NORMAL, ts: ts("2026-09-17T19:00:00Z") },
    ]);
    const items = (await fetcher.fetch(source, { config, clock, slackApi: fn, env })).items;
    const ranked = rankItems(items, clock.now());
    expect(ranked[0]!.item.title).toMatch(/^Lantern Freight/);
    expect(ranked[1]!.item.title).toMatch(/^MARKED FOR REVIEW/);
    expect(ranked[1]!.reasons.join()).toMatch(/requires review -2/);
  });

  it("never invents a link: if Slack gives no permalink the update is skipped and a warning says so", async () => {
    const { fn } = slack([{ text: NORMAL, ts: ts("2026-09-17T20:00:00Z") }], { permalinkFails: true });
    const r = await fetcher.fetch(source, { config, clock, slackApi: fn, env });
    expect(r.items).toEqual([]);
    expect(r.warnings.join()).toMatch(/could not get a permalink for the Lantern Freight update/);
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
        "Lantern Freight: Three hires and a metric they're proud of.",
        "MARKED FOR REVIEW: Bellwether Soil: Good material, can't run it yet.",
      ]);
      const held = run.candidates.find((c) => c.item.requires_review)!;
      expect(run.preselected_ids).not.toContain(held.item.id);
      expect(run.preselected_ids).toHaveLength(1);

      // The embargoed grant must not appear anywhere in what was drafted automatically.
      for (const d of run.drafts) {
        const md = readFileSync(d.file_md, "utf8");
        expect(md, d.id).not.toContain("Bellwether");
        expect(md, d.id).not.toContain("embargo");
        expect(md, d.id).toContain("Lantern Freight");
      }
    } finally {
      storage.close();
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});

describe("founder updates in the drafts", () => {
  it("appear under their own heading, not under Volta's LinkedIn, and pass the no-fabrication check", async () => {
    const { fn } = slack([{ text: NORMAL, ts: ts("2026-09-17T20:00:00Z") }, { text: EMBARGO, ts: ts("2026-09-15T20:00:00Z") }]);
    const items = (await new SlackChannelFetcher().fetch(source, { config, clock, slackApi: fn, env: { SLACK_BOT_TOKEN: "x" } })).items;
    const drafts = buildDrafts(items, { timeZone: config.timezone });

    for (const d of drafts) expect(d.verification.violations, `${d.id}: ${JSON.stringify(d.verification.violations)}`).toEqual([]);
    const standard = drafts[1]!.markdown;
    expect(standard).toContain("## From our members");
    expect(standard).toContain("**Lantern Freight: Three hires and a metric they're proud of.**");
    expect(standard).toContain("**MARKED FOR REVIEW: Bellwether Soil");
    expect(standard).toContain("[Read the update](https://ghost24.slack.com/archives/");
    // Nothing of theirs is filed under Volta's own LinkedIn section.
    const linkedinSection = standard.split("## From Volta on LinkedIn")[1]!.split("## ")[0]!;
    expect(linkedinSection).toContain("No from volta on linkedin items this week.");
  });
});
