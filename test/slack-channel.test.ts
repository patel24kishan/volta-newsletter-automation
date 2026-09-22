import { describe, expect, it } from "vitest";
import { resolveClock } from "../src/clock.js";
import { validateConfig, type Config, type SourceConfig } from "../src/config.js";
import { SlackChannelFetcher } from "../src/fetchers/slack-channel.js";
import { validateItem } from "../src/schema.js";

const source: SourceConfig = { id: "member-links", kind: "slack_channel", type: "member_social", url: "", enabled: true, channel_id: "C0ABCDEF" };

function cfg(overrides: Partial<Config> = {}): Config {
  return {
    timezone: "America/Halifax", draft_layout: "events-first", send_day: "monday", reminder_time: "08:30", content_window_days: 7, events_window_days: 14,
    watchlist: ["Volta"], holiday_overrides: [], alert_recipients: [], sources: [source], ...overrides,
  };
}

const clock = resolveClock(["--now=2026-09-17T18:00:00Z"], {});
const fetcher = new SlackChannelFetcher();
const env = { SLACK_BOT_TOKEN: "xoxb-test" };

/** Slack timestamp for a date, as the API returns it. */
const ts = (iso: string) => `${Math.floor(Date.parse(iso) / 1000)}.000100`;

const permalink = (channel: string, messageTs: string) => `https://volta.slack.com/archives/${channel}/p${messageTs.replace(".", "")}`;

function api(messages: Array<Record<string, unknown>>, users: Record<string, string> = { U1: "Jitakshi S." }, extra: Record<string, unknown> = {}, opts: { permalinkFails?: boolean } = {}) {
  const calls: Array<{ method: string; params: Record<string, string> }> = [];
  const fn = async (method: string, params: Record<string, string>) => {
    calls.push({ method, params });
    if (method === "chat.getPermalink") {
      return opts.permalinkFails ? { ok: false, error: "message_not_found" } : { ok: true, permalink: permalink(params.channel!, params.message_ts!) };
    }
    if (method === "users.info") {
      const name = users[params.user as string];
      return name ? { ok: true, user: { real_name: name } } : { ok: false, error: "user_not_found" };
    }
    return { ok: true, messages, ...extra };
  };
  return { fn, calls };
}

describe("SlackChannelFetcher", () => {
  it("turns a member's shared link into an item attributed to them, with their note as the summary", async () => {
    const { fn, calls } = api([
      { type: "message", user: "U1", ts: ts("2026-09-16T14:00:00Z"), text: "Proud to share that our founder was on CBC this morning. Great piece <https://cbc.ca/story|CBC story>" },
    ]);
    const r = await fetcher.fetch(source, { config: cfg(), clock, slackApi: fn, env });

    expect(r.error).toBeUndefined();
    expect(r.items).toHaveLength(1);
    const it = r.items[0]!;
    expect(validateItem(it)).toEqual({ ok: true, errors: [] });
    expect(it).toMatchObject({
      source: "member-links", type: "member_social", link: "https://cbc.ca/story",
      needs_summary: false, source_ref: `slack:C0ABCDEF:${ts("2026-09-16T14:00:00Z")}`,
    });
    expect(it.date).toBe("2026-09-16T14:00:00.000Z");
    expect(it.summary).toContain("founder was on CBC");
    // Attribution is in the excerpt, so the verifier can trace the submitter's name.
    expect(it.raw_excerpt).toContain("Jitakshi S. shared");

    // Only the window is requested, and the link markup is not left in the text.
    expect(calls[0]!.method).toBe("conversations.history");
    expect(Number(calls[0]!.params.oldest)).toBeCloseTo((Date.parse("2026-09-10T18:00:00Z")) / 1000, 0);
    expect(it.summary).not.toContain("<https://");
  });

  it("links back to the Slack message itself, using Slack's own permalink", async () => {
    const at = ts("2026-09-16T14:00:00Z");
    const { fn, calls } = api([{ type: "message", user: "U1", ts: at, text: "Great piece <https://cbc.ca/story>" }]);
    const r = await fetcher.fetch(source, { config: cfg(), clock, slackApi: fn, env });
    const it = r.items[0]!;
    expect(it.link).toBe("https://cbc.ca/story"); // the story stays the main link
    expect(it.message_link).toBe(permalink("C0ABCDEF", at));
    expect(validateItem(it)).toEqual({ ok: true, errors: [] });
    expect(calls.find((c) => c.method === "chat.getPermalink")!.params).toMatchObject({ channel: "C0ABCDEF", message_ts: at });
    expect(r.warnings).toEqual([]);
  });

  it("keeps the item without a message link when Slack gives no permalink, and says so once", async () => {
    const { fn } = api([
      { type: "message", user: "U1", ts: ts("2026-09-16T14:00:00Z"), text: "<https://a.test/1>" },
      { type: "message", user: "U1", ts: ts("2026-09-16T15:00:00Z"), text: "<https://b.test/2>" },
    ], undefined, {}, { permalinkFails: true });
    const r = await fetcher.fetch(source, { config: cfg(), clock, slackApi: fn, env });
    expect(r.items).toHaveLength(2);
    expect(r.items.every((i) => i.message_link === undefined)).toBe(true);
    expect(r.warnings.filter((w) => /message link/.test(w))).toEqual(["2 message link(s) could not be fetched, so those items show only the shared link"]);
  });

  it("flags a bare link as needing a summary rather than inventing one", async () => {
    const { fn } = api([{ type: "message", user: "U1", ts: ts("2026-09-16T14:00:00Z"), text: "<https://example.com/post>" }]);
    const r = await fetcher.fetch(source, { config: cfg(), clock, slackApi: fn, env });
    expect(r.items[0]).toMatchObject({ summary: "", needs_summary: true, title: "Jitakshi S. shared a link" });
  });

  it("keeps extra links in the same message as related, never dropping one", async () => {
    const { fn } = api([{ type: "message", user: "U1", ts: ts("2026-09-16T14:00:00Z"), text: "Two mentions this week <https://a.test/1> and <https://b.test/2>" }]);
    const r = await fetcher.fetch(source, { config: cfg(), clock, slackApi: fn, env });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.link).toBe("https://a.test/1");
    expect(r.items[0]!.related).toEqual([{ source: "member-links", link: "https://b.test/2", title: "Also shared by Jitakshi S." }]);
  });

  it("skips chatter with no link, and joins and other subtypes, and says how many", async () => {
    const { fn } = api([
      { type: "message", user: "U1", ts: ts("2026-09-16T14:00:00Z"), text: "nice work everyone!" },
      { type: "message", subtype: "channel_join", user: "U1", ts: ts("2026-09-16T13:00:00Z"), text: "has joined the channel" },
      { type: "message", user: "U1", ts: ts("2026-09-16T12:00:00Z"), text: "here it is <https://good.test/x>" },
    ]);
    const r = await fetcher.fetch(source, { config: cfg(), clock, slackApi: fn, env });
    expect(r.items.map((i) => i.link)).toEqual(["https://good.test/x"]);
    expect(r.warnings.join()).toMatch(/1 message\(s\) had no link/);
  });

  it("orders newest first and looks each submitter up only once", async () => {
    const { fn, calls } = api([
      { type: "message", user: "U1", ts: ts("2026-09-15T10:00:00Z"), text: "older <https://a.test/1>" },
      { type: "message", user: "U1", ts: ts("2026-09-17T10:00:00Z"), text: "newer <https://b.test/2>" },
    ]);
    const r = await fetcher.fetch(source, { config: cfg(), clock, slackApi: fn, env });
    expect(r.items.map((i) => i.link)).toEqual(["https://b.test/2", "https://a.test/1"]);
    expect(calls.filter((c) => c.method === "users.info")).toHaveLength(1);
  });

  it("still produces the item when the submitter cannot be named", async () => {
    const { fn } = api([{ type: "message", user: "U_UNKNOWN", ts: ts("2026-09-16T14:00:00Z"), text: "<https://a.test/1>" }], {});
    const r = await fetcher.fetch(source, { config: cfg(), clock, slackApi: fn, env });
    expect(r.items[0]!.title).toBe("A member shared a link");
  });

  it("an empty channel is zero items with no error, so the draft can say so", async () => {
    const { fn } = api([]);
    const r = await fetcher.fetch(source, { config: cfg(), clock, slackApi: fn, env });
    expect(r.error).toBeUndefined();
    expect(r.items).toEqual([]);
  });

  it("warns when the channel had more messages than one page", async () => {
    const { fn } = api([{ type: "message", user: "U1", ts: ts("2026-09-16T14:00:00Z"), text: "<https://a.test/1>" }], undefined, { has_more: true });
    const r = await fetcher.fetch(source, { config: cfg(), clock, slackApi: fn, env });
    expect(r.warnings.join()).toMatch(/only the most recent 1 were read/);
  });

  describe("setup failures say exactly what to fix", () => {
    const cases: Array<[string, RegExp]> = [
      ["missing_scope", /add channels:history and channels:read.*reinstall/],
      ["not_in_channel", /invite the bot to the channel/],
      ["channel_not_found", /check channel_id in config/],
      ["invalid_auth", /Slack refused the request: invalid_auth/],
    ];
    for (const [error, expected] of cases) {
      it(error, async () => {
        const fn = async () => ({ ok: false, error });
        const r = await fetcher.fetch(source, { config: cfg(), clock, slackApi: fn, env });
        expect(r.error).toMatch(expected);
        expect(r.items).toEqual([]);
      });
    }

    it("no token and no channel id are reported as errors, not empty successes", async () => {
      const { fn } = api([]);
      expect((await fetcher.fetch(source, { config: cfg(), clock, slackApi: fn, env: {} })).items).toEqual([]);
      const noChannel: SourceConfig = { ...source };
      delete noChannel.channel_id;
      expect((await fetcher.fetch(noChannel, { config: cfg(), clock, slackApi: fn, env })).error).toMatch(/no channel_id/);
      // Without an injected caller and without a token, it must not silently return nothing.
      expect((await fetcher.fetch(source, { config: cfg(), clock, env: {} })).error).toMatch(/SLACK_BOT_TOKEN is not set/);
    });

    it("a thrown network error is reported", async () => {
      const fn = async () => { throw new Error("ECONNRESET"); };
      expect((await fetcher.fetch(source, { config: cfg(), clock, slackApi: fn, env })).error).toMatch(/could not read the Slack channel: ECONNRESET/);
    });
  });
});

describe("slack_channel source config", () => {
  const base = {
    timezone: "America/Halifax", draft_layout: "events-first", send_day: "monday", reminder_time: "08:30", content_window_days: 7, events_window_days: 14,
    watchlist: ["Volta"], holiday_overrides: [], alert_recipients: ["bader"],
  };

  it("needs a channel id, not a URL", () => {
    const c = validateConfig({ ...base, sources: [{ id: "m", kind: "slack_channel", type: "member_social", url: "", enabled: true, channel_id: "C0ABCDEF" }] });
    expect(c.sources[0]).toMatchObject({ channel_id: "C0ABCDEF", url: "" });
  });

  it("names the problem when the channel id is missing or malformed", () => {
    for (const channel_id of [undefined, "", "#member-links", "abc"]) {
      expect(() => validateConfig({ ...base, sources: [{ id: "m", kind: "slack_channel", type: "member_social", url: "", enabled: true, ...(channel_id === undefined ? {} : { channel_id }) }] }), String(channel_id))
        .toThrow(/channel_id must be a Slack channel id/);
    }
  });
});
