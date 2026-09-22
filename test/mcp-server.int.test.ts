/**
 * Integration: the newsletter as Claude sees it. A real MCP client talks to the server over the
 * SDK's in-memory transport and walks the whole monthly loop on fixture sources, exactly as the
 * Claude app would: status, prepare, list, tick, add, edit, build, approve, send, restart.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryAlerter } from "../src/alerts.js";
import { resolveClock } from "../src/clock.js";
import type { Config } from "../src/config.js";
import type { Draft } from "../src/draft/templates.js";
import { createNewsletterServer, INSTRUCTIONS } from "../src/mcp/newsletter-server.js";
import type { PublishedCampaign, Publisher } from "../src/publish/types.js";
import { runWeek } from "../src/run-week.js";
import { SqliteStorage } from "../src/storage.js";

const config: Config = {
  timezone: "America/Halifax", cadence: "monthly", draft_layout: "events-first", send_day: "monday", reminder_time: "08:30",
  content_window_days: 7, events_window_days: 14, watchlist: ["Volta"], holiday_overrides: [], alert_recipients: [],
  sources: [
    { id: "google-news", kind: "rss", type: "news", url: "https://news.test/rss", enabled: true },
    { id: "volta-calendar", kind: "ics", type: "event", url: "https://cal.test/ics", enabled: true },
    { id: "manual-events", kind: "manual", type: "event", url: "", enabled: true, fallback_link: "https://voltaeffect.com/events" },
  ],
};
const BODIES: Record<string, string> = {
  "https://news.test/rss": `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
<item><title>Volta opens applications for its fall cohort</title><link>https://news.test/cohort</link><guid>c</guid><pubDate>Thu, 03 Sep 2026 12:00:00 GMT</pubDate><description>Volta opened applications for its fall cohort of founders. Applications close in October.</description></item>
</channel></rss>`,
  "https://cal.test/ics": ["BEGIN:VCALENDAR", "VERSION:2.0",
    "BEGIN:VEVENT", "UID:demo", "SUMMARY:Demo Night", "DTSTART:20260917T220000Z", "DTEND:20260918T000000Z", "URL:https://www.eventbrite.ca/e/demo", "DESCRIPTION:Founders demo what they built this summer.", "LOCATION:Volta", "END:VEVENT",
    "BEGIN:VEVENT", "UID:mixer", "SUMMARY:Fall Mixer", "DTSTART:20261022T210000Z", "DTEND:20261022T230000Z", "URL:https://www.eventbrite.ca/e/mixer", "DESCRIPTION:Meet the fall cohort.", "LOCATION:Volta", "END:VEVENT",
    "END:VCALENDAR"].join("\r\n"),
};

class FakeMail implements Publisher {
  readonly platform = "Mailchimp";
  published: Draft[] = [];
  sent: string[] = [];
  async verify() { return { audienceName: "Test", memberCount: 2 }; }
  updated: Array<{ id: string; draft: Draft }> = [];
  async publishDraft(d: Draft): Promise<PublishedCampaign> { this.published.push(d); return { id: `camp_${this.published.length}`, editUrl: "https://mc.test/e", platform: this.platform }; }
  async updateDraft(id: string, draft: Draft) { this.updated.push({ id, draft }); }
  async send(id: string) { this.sent.push(id); }
}

let dir: string;
let storage: SqliteStorage;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "volta-mcp-")); storage = new SqliteStorage(join(dir, "db.sqlite")); });
afterEach(() => { storage.close(); rmSync(dir, { recursive: true, force: true }); });

const clock = resolveClock(["--now=2026-10-01T11:30:00Z"], {});

async function connect(o: { live?: boolean; mail?: Publisher } = {}) {
  let runs = 0;
  const server = createNewsletterServer({
    config, clock, storage, alerter: new MemoryAlerter(), outDir: dir, env: { ALLOW_LIVE: o.live ? "1" : "0" },
    runPeriod: async () => { runs++; return runWeek({ config, clock, storage, alerter: new MemoryAlerter(), outDir: dir, fetchText: async (u) => BODIES[u] ?? "" }); },
    ...(o.mail ? { publisher: o.mail, audience: { audienceName: "Test", memberCount: 2 } } : {}),
    preview: async () => ({ put: (_html: string, id?: string) => `http://127.0.0.1:3111/preview/${id ?? "x"}` }),
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
    return { text: r.content.map((c) => c.text).join("\n"), isError: Boolean(r.isError) };
  };
  return { client, call, runs: () => runs, close: () => client.close() };
}

/** The id printed under a candidate's title in list_candidates. */
function idOf(list: string, title: string): string {
  const at = list.indexOf(title);
  const m = /id: (\S+)/.exec(list.slice(at));
  if (at < 0 || !m) throw new Error(`no id for ${title}`);
  return m[1]!;
}

describe("the newsletter tools, as Claude uses them", () => {
  it("offers the tools with the rules as instructions, and takes no newsletter text where it must not", async () => {
    const c = await connect();
    const { tools } = await c.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["add_event", "approve_draft", "build_draft", "edit_item", "list_candidates", "newsletter_status", "prepare_month", "send_campaign", "set_selection"]);
    expect(c.client.getInstructions()).toBe(INSTRUCTIONS);
    expect(INSTRUCTIONS).toMatch(/Never write newsletter text yourself/);
    // Building, approving and sending take ids only: Claude cannot hand them words to publish.
    const props = (n: string) => Object.keys((tools.find((t) => t.name === n)!.inputSchema.properties ?? {}) as object).sort();
    expect(props("build_draft")).toEqual([]);
    expect(props("approve_draft")).toEqual(["draft_key"]);
    expect(props("send_campaign")).toEqual(["campaign_id", "confirm"]);
    await c.close();
  });

  it("walks the month: prepare, list in groups, tick, add, edit, build and approve in dry run", async () => {
    const out = vi.spyOn(process.stdout, "write");
    const c = await connect();

    expect((await c.call("newsletter_status")).text).toMatch(/Period: 2026-10 \(monthly\)[\s\S]*Not prepared yet[\s\S]*dry run/);
    expect((await c.call("list_candidates")).isError).toBe(true);

    const prep = await c.call("prepare_month");
    expect(prep.text).toMatch(/Prepared the month of 2026-10: 3 candidates \(1 upcoming events, 1 past events, 1 news and updates\)/);
    expect((await c.call("prepare_month")).text).toMatch(/Already prepared/);
    expect(c.runs()).toBe(1);

    const list = (await c.call("list_candidates")).text;
    expect(list.indexOf("## Upcoming events")).toBeLessThan(list.indexOf("Fall Mixer"));
    expect(list.indexOf("## Past events (last month)")).toBeLessThan(list.indexOf("Demo Night"));
    expect(list).toMatch(/\[ \] Demo Night \| held 2026-09-17 19:00 at Volta/); // past: not pre-ticked
    const mixer = idOf(list, "Fall Mixer");
    const demo = idOf(list, "Demo Night");

    expect((await c.call("set_selection", { tick: [demo, "nope"] })).text).toMatch(/Not candidates, ignored: nope/);
    const added = await c.call("add_event", { title: "Pitch Night", date: "2026-10-15", time: "19:00", location: "Volta", description: "Founders pitch to mentors." });
    expect(added.text).toMatch(/Added and ticked:\n- \[x\] Pitch Night \| on 2026-10-15 19:00 at Volta/);
    expect((await c.call("add_event", { title: "Old one", date: "2026-09-01", time: "19:00" })).text).toMatch(/Not added[\s\S]*starts_at/);

    expect((await c.call("edit_item", { item_id: mixer, field: "summary", text: "Drinks, demos and the whole fall cohort." })).text).toMatch(/edited by Bader: description/);
    expect((await c.call("edit_item", { item_id: mixer, field: "title", text: "Party" })).isError).toBe(true);

    const built = await c.call("build_draft");
    expect(built.text).toMatch(/Subject: Volta this month: /);
    expect(built.text).toMatch(/Preview: http:\/\/127\.0\.0\.1:3111\/preview\//);
    expect(built.text).toMatch(/Edited by Bader: Fall Mixer \(description\)/);
    expect(built.text).toContain("Drinks, demos and the whole fall cohort.");
    expect(built.text).toContain("## Last month at Volta");
    expect(built.text).toContain("Pitch Night");
    const key = /Draft key: (\S+)/.exec(built.text)![1]!;

    const approved = await c.call("approve_draft", { draft_key: key });
    expect(approved.text).toMatch(/^Approved and saved to /); // no platform configured here
    expect((await c.call("send_campaign", { campaign_id: "camp_1", confirm: true })).text).toMatch(/Dry run: nothing was sent/);

    // stdout carries the protocol in the real server: the tools themselves never print.
    expect(out).not.toHaveBeenCalled();
    out.mockRestore();
    await c.close();
  });

  it("in dry run with an email platform, approve creates nothing", async () => {
    const mail = new FakeMail();
    const c = await connect({ mail });
    await c.call("prepare_month");
    const key = /Draft key: (\S+)/.exec((await c.call("build_draft")).text)![1]!;
    expect((await c.call("approve_draft", { draft_key: key })).text).toMatch(/Dry run: .*no campaign was created/);
    expect(mail.published).toEqual([]);
    await c.close();
  });

  it("live: approves once, refuses a stale key, sends only with confirm, and never twice", async () => {
    const mail = new FakeMail();
    const c = await connect({ live: true, mail });
    await c.call("prepare_month");
    const first = /Draft key: (\S+)/.exec((await c.call("build_draft")).text)![1]!;
    const second = /Draft key: (\S+)/.exec((await c.call("build_draft")).text)![1]!;
    expect((await c.call("approve_draft", { draft_key: first })).text).toMatch(/no longer current/);
    const ok = await c.call("approve_draft", { draft_key: second });
    expect(ok.text).toMatch(/Campaign camp_1 created in Mailchimp \(not sent\)[\s\S]*Audience: Test \(2 contacts\)/);
    expect((await c.call("approve_draft", { draft_key: second })).text).toMatch(/Already approved/);
    expect(mail.published).toHaveLength(1);

    expect((await c.call("send_campaign", { campaign_id: "camp_1", confirm: false })).text).toMatch(/Not sent: confirm must be true/);
    expect(mail.sent).toEqual([]);
    expect((await c.call("send_campaign", { campaign_id: "camp_1", confirm: true })).text).toBe("Sent via Mailchimp.");
    expect((await c.call("send_campaign", { campaign_id: "camp_1", confirm: true })).text).toMatch(/already sent/);
    expect(mail.sent).toEqual(["camp_1"]);
    expect((await c.call("newsletter_status")).text).toMatch(/campaign camp_1 in Mailchimp/);
    await c.close();
  });

  it("live: a change after approval updates the same campaign, and a sent month cannot be changed", async () => {
    const mail = new FakeMail();
    const c = await connect({ live: true, mail });
    await c.call("prepare_month");
    const key1 = /Draft key: (\S+)/.exec((await c.call("build_draft")).text)![1]!;
    expect((await c.call("approve_draft", { draft_key: key1 })).text).toMatch(/Campaign camp_1 created/);

    // Bader changes his mind: rewords the mixer, rebuilds, approves again.
    const mixer = idOf((await c.call("list_candidates")).text, "Fall Mixer");
    await c.call("edit_item", { item_id: mixer, field: "summary", text: "Drinks, demos and the whole fall cohort." });
    const key2 = /Draft key: (\S+)/.exec((await c.call("build_draft")).text)![1]!;
    const updated = await c.call("approve_draft", { draft_key: key2 });
    expect(updated.text).toContain("campaign camp_1 in Mailchimp was updated with the new version (still not sent): https://mc.test/e");
    expect(updated.text).toMatch(/changes Bader made directly in Mailchimp have been replaced/);
    expect(mail.published).toHaveLength(1);
    expect(mail.updated.map((u) => u.id)).toEqual(["camp_1"]);
    expect(mail.updated[0]!.draft.html).toContain("Drinks, demos and the whole fall cohort.");

    expect((await c.call("send_campaign", { campaign_id: "camp_1", confirm: true })).text).toBe("Sent via Mailchimp.");
    await c.call("set_selection", { untick: [mixer] });
    const key3 = /Draft key: (\S+)/.exec((await c.call("build_draft")).text)![1]!;
    const refused = await c.call("approve_draft", { draft_key: key3 });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("already sent (campaign camp_1)");
    expect(mail.updated).toHaveLength(1);
    expect(mail.published).toHaveLength(1);
    await c.close();
  });

  it("after a restart, picks the month up where it was left: ticks, edits and the draft", async () => {
    const before = await connect();
    await before.call("prepare_month");
    const list = (await before.call("list_candidates")).text;
    const demo = idOf(list, "Demo Night");
    const mixer = idOf(list, "Fall Mixer");
    await before.call("set_selection", { tick: [demo] });
    await before.call("edit_item", { item_id: mixer, field: "location", text: "Volta, 1505 Barrington St" });
    await before.call("build_draft");
    await before.close();

    const after = await connect();
    const status = (await after.call("newsletter_status")).text;
    expect(status).toMatch(/Prepared: 3 candidates, 3 ticked/);
    expect(status).toMatch(/Draft: "Volta this month: /);
    expect(after.runs()).toBe(0); // nothing fetched again
    const rebuilt = (await after.call("build_draft")).text;
    expect(rebuilt).toContain("Where: Volta, 1505 Barrington St");
    expect(rebuilt).toContain("Demo Night");
    await after.close();
  });
});
