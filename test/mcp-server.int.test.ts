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
import type { CampaignState, PublishedCampaign, Publisher } from "../src/publish/types.js";
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
  async updateDraft(id: string, draft: Draft) {
    // Mailchimp's own answer for a campaign that is not there, which is where the curator got stuck.
    if (this.deletedThere.has(id)) throw Object.assign(new Error("Mailchimp update campaign failed (HTTP 404): Resource Not Found"), { status: 404 });
    this.updated.push({ id, draft });
  }
  async send(id: string) { this.sent.push(id); }
  /** Campaigns the curator deleted in the platform's own interface, which this side cannot see. */
  deletedThere = new Set<string>();
  async campaignState(id: string): Promise<CampaignState> {
    if (this.deletedThere.has(id)) return "missing";
    return this.sent.includes(id) ? "sent" : "draft";
  }
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
    fetchText: async (u: string) => { const b = BODIES[u]; if (b === undefined) throw new Error(`GET ${u} failed`); return b; },
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
    expect(tools.map((t) => t.name).sort()).toEqual(["add_event", "add_source", "approve_draft", "build_draft", "edit_item", "list_candidates", "list_sources", "monthly_reminder", "newsletter_status", "prepare_month", "remove_event", "remove_source", "send_campaign", "set_selection", "set_source"]);
    expect(c.client.getInstructions()).toBe(INSTRUCTIONS);
    expect(INSTRUCTIONS).toMatch(/Never write newsletter text yourself/);
    // Building, approving and sending take ids only: Claude cannot hand them words to publish.
    const props = (n: string) => Object.keys((tools.find((t) => t.name === n)!.inputSchema.properties ?? {}) as object).sort();
    expect(props("build_draft")).toEqual([]);
    expect(props("monthly_reminder")).toEqual([]); // the scheduled task cannot steer it
    expect(props("approve_draft")).toEqual(["draft_key"]);
    expect(props("send_campaign")).toEqual(["campaign_id", "confirm"]);
    await c.close();
  });

  it("offers the review panel, and feeds it the same data the panel's own buttons change", async () => {
    const c = await connect();
    const { tools } = await c.client.listTools();
    const list = tools.find((t) => t.name === "list_candidates")!;
    expect(list._meta).toMatchObject({ ui: { resourceUri: "ui://volta-newsletter/review-panel.html" }, "ui/resourceUri": "ui://volta-newsletter/review-panel.html" });

    const { resources } = await c.client.listResources();
    expect(resources).toContainEqual(expect.objectContaining({ uri: "ui://volta-newsletter/review-panel.html", mimeType: "text/html;profile=mcp-app" }));
    const page = await c.client.readResource({ uri: "ui://volta-newsletter/review-panel.html" });
    expect(page.contents[0]).toMatchObject({ mimeType: "text/html;profile=mcp-app" });
    expect(String((page.contents[0] as { text: string }).text)).toContain('<main id="root">');

    // The panel reads the newsletter itself from here, because the app will not open the preview
    // server's loopback address. Empty until something is built, never missing.
    expect(resources).toContainEqual(expect.objectContaining({ uri: "ui://volta-newsletter/current-draft.html", mimeType: "text/html" }));
    const beforeBuild = await c.client.readResource({ uri: "ui://volta-newsletter/current-draft.html" });
    expect(String((beforeBuild.contents[0] as { text: string }).text)).toBe("");

    await c.call("prepare_month");
    const first = (await c.client.callTool({ name: "list_candidates", arguments: {} })) as unknown as { structuredContent: { periodLabel: string; dryRun: boolean; ticked: number; total: number; groups: Array<{ key: string; items: Array<{ id: string; title: string; ticked: boolean }> }> } };
    expect(first.structuredContent).toMatchObject({ periodLabel: "October 2026", dryRun: true, total: 3 });
    expect(first.structuredContent.groups.map((g) => g.key)).toEqual(["upcoming", "past", "other"]);
    const demo = first.structuredContent.groups[1]!.items.find((i) => i.title === "Demo Night")!;
    expect(demo.ticked).toBe(false);

    // What the panel does when a box is ticked: send that one change, then read the list again.
    await c.client.callTool({ name: "set_selection", arguments: { tick: [demo.id] } });
    const after = (await c.client.callTool({ name: "list_candidates", arguments: {} })) as unknown as typeof first;
    expect(after.structuredContent.ticked).toBe(first.structuredContent.ticked + 1);
    expect(after.structuredContent.groups[1]!.items.find((i) => i.id === demo.id)!.ticked).toBe(true);

    // Build from the panel: the result carries what the panel shows (subject, preview, key).
    const built = (await c.client.callTool({ name: "build_draft", arguments: {} })) as unknown as { structuredContent: { key: string; subject: string; previewUrl: string | null; notes: string[] } };
    expect(built.structuredContent.subject).toBe("Volta this month: October 2026");
    expect(built.structuredContent.previewUrl).toMatch(/^http:\/\/127\.0\.0\.1:3111\/preview\//);
    expect(built.structuredContent.key).toMatch(/^[0-9a-f-]{36}$/);

    // And now the resource carries the built newsletter, which is what the panel shows in place.
    const shown = await c.client.readResource({ uri: "ui://volta-newsletter/current-draft.html" });
    const html = String((shown.contents[0] as { text: string }).text);
    expect(html).toContain("<html");
    expect(html).toContain(built.structuredContent.subject);
    await c.close();
  });

  /**
   * Asking for one group narrows the panel too, and Claude can do that in the chat without Bader
   * asking. A tick sent from that view as "the selection is now exactly these" unticked everything
   * off screen: three ticked items became one, silently, with the pre-ticked list unrecoverable.
   */
  /**
   * `select` replaces the whole selection, so a list built from part of the month drops everything
   * it leaves out. That is how an event the curator had just added left his newsletter: the reply
   * said "16 ticked", which was true, and said nothing about the one that had gone.
   */
  it("says what came off the list, not only what is still on it", async () => {
    const c = await connect();
    await c.call("prepare_month");
    const list = (await c.call("list_candidates")).text;
    const mixer = idOf(list, "Fall Mixer");
    const cohort = idOf(list, "Volta opens applications for its fall cohort");

    await c.call("set_selection", { select: [mixer, cohort] });
    // A replacement that leaves one out: the loss has to be said, not left to be noticed.
    const narrowed = await c.call("set_selection", { select: [mixer] });
    expect(narrowed.text).toContain("1 ticked: Fall Mixer");
    expect(narrowed.text).toContain("No longer ticked: Volta opens applications for its fall cohort");
    expect(narrowed.text).toContain("Say so if any of those should stay in");

    // Unticking on purpose says the same thing; there is nothing to hide either way.
    expect((await c.call("set_selection", { untick: [mixer] })).text).toContain("No longer ticked: Fall Mixer");
    // And a change that removes nothing does not invent a line about it.
    expect((await c.call("set_selection", { tick: [cohort] })).text).not.toContain("No longer ticked");
    await c.close();
  });

  it("keeps the items it is not showing when a box is ticked in a narrowed panel", async () => {
    const c = await connect();
    await c.call("prepare_month");
    type Panel = { structuredContent: { ticked: number; total: number; showing?: string; groups: Array<{ key: string; title: string; items: Array<{ id: string; title: string; ticked: boolean }> }> } };
    const list = async (args: Record<string, unknown>) => (await c.client.callTool({ name: "list_candidates", arguments: args })) as unknown as Panel;

    const all = await list({});
    expect(all.structuredContent.ticked).toBe(2);

    // "Just show me the upcoming events."
    const upcoming = await list({ group: "upcoming" });
    expect(upcoming.structuredContent.groups.map((g) => g.key)).toEqual(["upcoming"]);
    expect(upcoming.structuredContent.showing).toBe("upcoming");
    // The counts still describe the whole month, which is why the panel has to say it is narrowed.
    expect(upcoming.structuredContent).toMatchObject({ ticked: 2, total: 3 });

    const mixer = upcoming.structuredContent.groups[0]!.items.find((i) => i.title === "Fall Mixer")!;
    expect(mixer.ticked).toBe(true);
    await c.client.callTool({ name: "set_selection", arguments: { untick: [mixer.id] } });

    const after = await list({});
    expect(after.structuredContent.ticked).toBe(1);
    const news = after.structuredContent.groups.find((g) => g.key === "other")!.items[0]!;
    expect(news.title).toBe("Volta opens applications for its fall cohort");
    expect(news.ticked).toBe(true);
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

    // A link pasted without the scheme is what Bader actually types; it is filled in, not refused.
    const pasted = await c.call("add_event", { title: "Open House", date: "2026-10-20", time: "17:00", link: "www.eventbrite.ca/e/open-house-1" });
    expect(pasted.isError).toBeFalsy();
    expect(pasted.text).toContain("https://www.eventbrite.ca/e/open-house-1");
    // Something that is not an address at all still gets the sentence that says what to do.
    const junk = await c.call("add_event", { title: "Nope", date: "2026-10-21", time: "17:00", link: "a link to the page" });
    expect(junk.isError).toBe(true);
    expect(junk.text).toMatch(/link: Enter a full link starting with http:\/\/ or https:\/\//);
    // And a link forgotten at first is fixed in place, rather than by adding the event again.
    const openHouse = /id: (manual-events:[^\s)]+)/.exec((await c.call("list_candidates")).text)?.[1];
    expect(openHouse, "the added event should be listed").toBeDefined();
    expect((await c.call("edit_item", { item_id: openHouse!, field: "link", text: "lu.ma/open-house" })).text).toContain("https://lu.ma/open-house");

    expect((await c.call("edit_item", { item_id: mixer, field: "summary", text: "Drinks, demos and the whole fall cohort." })).text).toMatch(/edited by Bader: description/);
    expect((await c.call("edit_item", { item_id: mixer, field: "title", text: "Party" })).isError).toBe(true);

    const built = await c.call("build_draft");
    // The month, not the event just added and ticked: nothing Bader adds can take the title.
    expect(built.text).toContain("Subject: Volta this month: October 2026");
    expect(built.text).not.toContain("Subject: Volta this month: Pitch Night");
    expect(built.text).toMatch(/Preview: http:\/\/127\.0\.0\.1:3111\/preview\//);
    expect(built.text).toContain("**Changed by you**\n• **Fall Mixer**: description");
    expect(built.text).toContain("Drinks, demos and the whole fall cohort.");
    expect(built.text).toContain("## Last month at Volta");
    expect(built.text).toContain("Pitch Night");
    const key = /Draft key: (\S+)/.exec(built.text)![1]!;

    const approved = await c.call("approve_draft", { draft_key: key });
    expect(approved.text).toMatch(/^Approved and saved to /); // no platform configured here
    expect((await c.call("send_campaign", { campaign_id: "camp_1", confirm: true })).text).toMatch(/practice run, so nothing was sent/);

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
    expect((await c.call("approve_draft", { draft_key: key })).text).toMatch(/practice run, so no email was created/);
    expect(mail.published).toEqual([]);
    await c.close();
  });

  it("live: approves once, refuses a stale key, sends only with confirm, and never twice", async () => {
    const mail = new FakeMail();
    const c = await connect({ live: true, mail });
    await c.call("prepare_month");
    const first = /Draft key: (\S+)/.exec((await c.call("build_draft")).text)![1]!;
    const second = /Draft key: (\S+)/.exec((await c.call("build_draft")).text)![1]!;
    // A superseded key is refused, and told which key to use rather than just that it is stale.
    const stale = await c.call("approve_draft", { draft_key: first });
    expect(stale.isError).toBe(true);
    expect(stale.text).toContain("does not match the draft I have");
    expect(stale.text).toContain(second);
    // A key that never existed gets the same true answer, not a claim that a newer one was built.
    const bogus = await c.call("approve_draft", { draft_key: "00000000-0000-0000-0000-000000000000" });
    expect(bogus.text).toContain("does not match the draft I have");
    expect(bogus.text).not.toContain("a newer one was built");
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
    expect(refused.text).toContain("already gone out (campaign camp_1)");
    expect(refused.text).toContain("subscribers have it");
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

/**
 * What a live run found, reproduced from the curator's side. He approved, deleted the campaign in
 * Mailchimp's own interface, and approved again: every attempt answered "Resource Not Found",
 * because this side went on trying to update an id the platform no longer had. The month could not
 * be approved again by any means available to him.
 */
describe("when the campaign is deleted in Mailchimp", () => {
  it("makes a fresh one instead of leaving the month stuck on an id that is gone", async () => {
    const mail = new FakeMail();
    const c = await connect({ live: true, mail });
    await c.call("prepare_month");
    const key = /Draft key: (\S+)/.exec((await c.call("build_draft")).text)![1]!;
    expect((await c.call("approve_draft", { draft_key: key })).text).toContain("Campaign camp_1 created");

    // He deletes it in Mailchimp. Nothing tells this side, which is the whole difficulty.
    mail.deletedThere.add("camp_1");

    const key2 = /Draft key: (\S+)/.exec((await c.call("build_draft")).text)![1]!;
    const again = await c.call("approve_draft", { draft_key: key2 });
    expect(again.isError).toBeFalsy();
    expect(again.text).toContain("Campaign camp_2 created");
    expect(mail.updated, "nothing may be sent to a campaign that is gone").toEqual([]);
    await c.close();
  });

  it("tells him his work is safe when the platform simply will not take it", async () => {
    const mail = new FakeMail();
    mail.publishDraft = async () => { throw new Error("Mailchimp create campaign failed (HTTP 500): Internal error"); };
    const c = await connect({ live: true, mail });
    await c.call("prepare_month");
    const key = /Draft key: (\S+)/.exec((await c.call("build_draft")).text)![1]!;
    const failed = await c.call("approve_draft", { draft_key: key });
    expect(failed.isError).toBe(true);
    // Not a bare platform error: what happened, that nothing went out, and what to do next.
    expect(failed.text).toContain("nothing was created there and nothing was sent");
    expect(failed.text).toContain("Your draft is safe");
    expect(failed.text).toContain("Try approving again");
    // The developer's sentence is still there, to be passed on rather than puzzled over.
    expect(failed.text).toContain("HTTP 500");
    await c.close();
  });
});

describe("an event Bader added for a later month", () => {
  /**
   * The month reads a fixed span of time, and every source is held to it. An event he typed was
   * held to it too: added in October for December, it was a candidate at once and printed in the
   * draft he built, then the next refresh read the manual events for this month only and it was
   * gone, with nothing said. He was left with a newsletter missing the event he had added to it.
   * His own entries are decisions rather than listings, so the future is now open-ended for them.
   */
  it("survives a refresh and reaches the newsletter, however far ahead it is", async () => {
    const c = await connect();
    await c.call("prepare_month");

    // December, well past the end of the October window this run reads.
    const added = await c.call("add_event", { title: "Winter Showcase", date: "2026-12-05", time: "18:00", link: "https://voltaeffect.com/winter" });
    expect(added.isError).toBeFalsy();
    const id = idOf((await c.call("list_candidates")).text, "Winter Showcase");

    await c.call("prepare_month", { force: true });
    const listed = (await c.call("list_candidates")).text;
    expect(listed, "the refresh must not quietly drop it").toContain("Winter Showcase");
    expect(listed).toContain(id);

    await c.call("set_selection", { tick: [id] });
    const draft = (await c.call("build_draft")).text;
    expect(draft).toContain("Winter Showcase");
    // In what is coming up, not in what was held: it has not happened yet.
    expect(draft.indexOf("Winter Showcase")).toBeGreaterThan(draft.indexOf("## Upcoming events"));
    await c.close();
  });
});

describe("an event Bader added and then wants to correct", () => {
  it("is fixed in place and can be removed, so it is never added twice", async () => {
    const c = await connect();
    await c.call("prepare_month");

    const added = await c.call("add_event", { title: "Open House", date: "2026-10-20", time: "17:00" });
    expect(added.isError).toBeFalsy();
    const id = /id: (manual-events:[^\s)]+)/.exec((await c.call("list_candidates")).text)?.[1];
    expect(id, "the added event should be listed").toBeDefined();

    // The correction he actually wants: the link he forgot, on the event he already added.
    expect((await c.call("edit_item", { item_id: id!, field: "link", text: "lu.ma/open-house" })).text).toContain("https://lu.ma/open-house");
    const once = (await c.call("list_candidates")).text.split("Open House").length - 1;
    expect(once, "still one event, not two").toBe(1);

    // Renamed, then removed: both messages must use the name he gave it, not the stored one.
    // Removing is the one step he cannot undo, so a confirmation naming a title he has already
    // renamed away is the confirmation he most needs to be able to trust.
    await c.call("edit_item", { item_id: id!, field: "title", text: "Autumn Open House" });
    const ticked = await c.call("set_selection", { tick: [id!] });
    expect(ticked.text).toContain("Autumn Open House");
    expect(ticked.text).not.toContain("Open House;");

    // Removing needs him to have said so.
    expect((await c.call("remove_event", { item_id: id! })).isError).toBe(true);
    const removed = await c.call("remove_event", { item_id: id!, confirm: true });
    expect(removed.text).toContain('Removed "Autumn Open House"');
    // And his wording goes with the item, rather than outliving what it described.
    expect(storage.listCuratorEdits("2026-10").filter((e) => e.item_id === id)).toEqual([]);
    expect((await c.call("list_candidates")).text).not.toContain("Open House");

    // Gone for good: a refresh re-reads every source and it does not come back.
    await c.call("prepare_month", { force: true });
    expect((await c.call("list_candidates")).text).not.toContain("Open House");
    await c.close();
  });

  it("refuses to remove anything that came from a source, and says what to do instead", async () => {
    const c = await connect();
    await c.call("prepare_month");
    const sourced = /id: (volta-calendar:[^\s)]+)/.exec((await c.call("list_candidates")).text)?.[1];
    expect(sourced, "a calendar event should be listed").toBeDefined();
    const r = await c.call("remove_event", { item_id: sourced!, confirm: true });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Untick it");
    expect((await c.call("list_candidates")).text).toContain(sourced!);
    await c.close();
  });
});

describe("the sources Bader manages himself", () => {
  const FEED = `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
<item><title>Volta member raises a seed round</title><link>https://entrevestor.test/a</link><guid>ea</guid><pubDate>Thu, 10 Sep 2026 09:00:00 GMT</pubDate><description>A Volta member closed a seed round. The company is in Halifax.</description></item>
</channel></rss>`;

  it("lists what is read, adds a feed, and its items appear once the month is fetched again", async () => {
    BODIES["https://entrevestor.test/feed"] = FEED;
    try {
      const c = await connect();
      await c.call("prepare_month");

      const before = await c.call("list_sources");
      expect(before.text).toContain("google-news (a feed)");
      expect(before.text).toContain("set up by the maintainer");
      expect(before.text).not.toContain("Entrevestor");

      const added = await c.call("add_source", { kind: "rss", url: "https://entrevestor.test/feed", name: "Entrevestor" });
      expect(added.isError).toBe(false);
      expect(added.text).toContain("Added a feed: Entrevestor reads https://entrevestor.test/feed");
      expect(added.text).toContain("keeps the newsletter's watchlist (Volta)");
      expect(added.text).toContain("Read it: 1 item(s)"); // the one-off check at add time
      expect(added.text).toContain("say: refresh this month");
      expect(added.text).toContain("Its id is cur_entrevestor.");

      // Not in the list until the month is fetched again, exactly as the message said.
      expect((await c.call("list_candidates")).text).not.toContain("Volta member raises a seed round");
      await c.call("prepare_month", { force: true });
      expect((await c.call("list_candidates")).text).toContain("Volta member raises a seed round");

      const after = await c.call("list_sources");
      expect(after.text).toContain("Entrevestor (a feed)");
      expect(after.text).toContain("added by you on 2026-10-01");
      await c.close();
    } finally {
      delete BODIES["https://entrevestor.test/feed"];
    }
  });

  it("turns one off, changes its keywords, and removes it only when he has said so", async () => {
    BODIES["https://entrevestor.test/feed"] = FEED;
    try {
      const c = await connect();
      await c.call("add_source", { kind: "rss", url: "https://entrevestor.test/feed", name: "Entrevestor", check: false });

      expect((await c.call("set_source", { source_id: "cur_entrevestor", keywords: ["seed round"] })).text)
        .toContain("keeps only items mentioning seed round");
      expect((await c.call("set_source", { source_id: "cur_entrevestor", enabled: false })).text).toContain("is now off");
      expect((await c.call("list_sources")).text).toContain("off · added by you");

      // Still his after being turned off: the keywords survive, and it can be turned back on.
      expect((await c.call("set_source", { source_id: "cur_entrevestor", enabled: true })).text)
        .toContain("is now on, and keeps only items mentioning seed round");

      const refused = await c.call("remove_source", { source_id: "cur_entrevestor", confirm: false });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain("only once Bader has said to remove it");
      expect((await c.call("remove_source", { source_id: "cur_entrevestor", confirm: true })).text).toContain("Removed Entrevestor");
      expect((await c.call("list_sources")).text).not.toContain("Entrevestor");
      await c.close();
    } finally {
      delete BODIES["https://entrevestor.test/feed"];
    }
  });

  it("will not change or remove one the maintainer set up, and says who to ask", async () => {
    const c = await connect();
    const changed = await c.call("set_source", { source_id: "google-news", enabled: false });
    expect(changed.isError).toBe(true);
    expect(changed.text).toBe("google-news is set up by the maintainer in the config file; ask them to change it.");
    expect((await c.call("remove_source", { source_id: "google-news", confirm: true })).text).toContain("ask them to remove it");
    expect((await c.call("set_source", { source_id: "cur_nothing", enabled: false })).text).toContain("There is no source called cur_nothing");
    await c.close();
  });

  it("takes a feed address pasted without its scheme, as the add-event link box does", async () => {
    BODIES["https://entrevestor.test/feed"] = FEED;
    try {
      const c = await connect();
      const r = await c.call("add_source", { kind: "rss", url: "entrevestor.test/feed", name: "Entrevestor", check: false });
      expect(r.isError).toBeFalsy();
      expect(r.text).toContain("https://entrevestor.test/feed");
      expect((await c.call("list_sources")).text).toContain("https://entrevestor.test/feed");
      await c.close();
    } finally {
      delete BODIES["https://entrevestor.test/feed"];
    }
  });

  it("says what a feed is missing rather than guessing at it", async () => {
    const c = await connect();
    const bad = await c.call("add_source", { kind: "rss", url: "the entrevestor feed page" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("a feed needs its full address, such as https://");
    expect((await c.call("add_source", { kind: "google_news" })).text).toContain("A news search needs the words to search for");
    expect((await c.call("add_source", { kind: "slack_channel", channel_id: "#members" })).text).toContain("Copy link");
    expect((await c.call("list_sources")).text).not.toContain("cur_");
    await c.close();
  });

  it("keeps a Slack channel he added but leaves it off while the token is missing, and never blocks the newsletter", async () => {
    const c = await connect();
    const added = await c.call("add_source", { kind: "slack_channel", channel_id: "https://volta.slack.com/archives/C0C2H7WAUJX", name: "Member updates" });
    expect(added.isError).toBe(false);
    expect(added.text).toContain("reads the Slack channel C0C2H7WAUJX");
    expect(added.text).toContain("SLACK_BOT_TOKEN is not set");
    expect(added.text).toContain("only the maintainer can do");
    expect((await c.call("list_sources")).text).toContain("off · added by you");

    // The month still prepares and the draft still builds, with the other sources.
    const prepared = await c.call("prepare_month");
    expect(prepared.isError).toBe(false);
    expect(prepared.text).toContain("candidates");
    await c.call("build_draft");
    expect((await c.call("newsletter_status")).text).toContain("Draft:");
    await c.close();
  });
});

describe("when sources are down, in the chat Bader sees", () => {
  it("prepares the month anyway, names what needs attention, and still builds a draft", async () => {
    // Every feed down: the worst case, and still no dead end for him.
    const saved = { ...BODIES };
    try {
      for (const k of Object.keys(BODIES)) delete BODIES[k];
      const c = await connect();
      const prepared = await c.call("prepare_month");
      expect(prepared.isError).toBe(false);
      expect(prepared.text).toContain("Sources that need attention:");
      expect(prepared.text).toMatch(/google-news (could not be read|found nothing)/);

      // Nothing was found, so nothing is built, and he is told why rather than "tick something".
      const built = await c.call("build_draft");
      expect(built.text).toContain("No candidates were found for this month, so there is nothing to build.");
      expect(built.text).toContain("Sources that need attention:");
      expect(built.text).toContain("Nothing is sent, and nothing is invented.");
      expect(built.text).not.toContain("Tick at least one item");
      await c.close();
    } finally {
      Object.assign(BODIES, saved);
    }
  });
});

describe("a source that did not work, as Bader reads it", () => {
  it("says what to do and where to go, and shows a channel link he can click", async () => {
    const c = await connect();
    await c.call("add_source", { kind: "slack_channel", channel_id: "https://volta.slack.com/archives/C0C2H7WAUJX", name: "Member updates" });

    const list = await c.call("list_sources");
    expect(list.text).toContain("open: https://slack.com/app_redirect?channel=C0C2H7WAUJX");
    expect(list.text).toContain("open: https://news.test/rss"); // every source carries its link
    await c.close();
  });

  it("explains a failed source in the month's preparation, with the remedy", async () => {
    const saved = BODIES["https://cal.test/ics"];
    try {
      delete BODIES["https://cal.test/ics"];
      const c = await connect();
      const prepared = await c.call("prepare_month");
      expect(prepared.text).toContain("Sources that need attention:");
      expect(prepared.text).toContain("volta-calendar could not be read");
      expect(prepared.text).toContain("The address answered with nothing at all. Check the link, then say: refresh this month.");
      expect(prepared.text).toContain("(https://cal.test/ics)");
      await c.close();
    } finally {
      BODIES["https://cal.test/ics"] = saved!;
    }
  });
});

describe("a feed of his that the watchlist empties", () => {
  // QA's blocker: he adds the feed he cares about, every story is dropped for not saying "Volta",
  // and every surface tells him it was a quiet month.
  const NATIONAL = `<?xml version="1.0"?><rss version="2.0"><channel><title>National tech</title>
<item><title>Calgary fintech raises a seed round</title><link>https://nat.test/a</link><guid>a</guid><pubDate>Thu, 10 Sep 2026 09:00:00 GMT</pubDate><description>A Calgary company raised money.</description></item>
<item><title>Toronto biotech hires a chief scientist</title><link>https://nat.test/b</link><guid>b</guid><pubDate>Fri, 11 Sep 2026 09:00:00 GMT</pubDate><description>A Toronto company hired someone.</description></item>
</channel></rss>`;

  it("says how many it published and how to keep them, instead of calling it quiet", async () => {
    BODIES["https://nat.test/feed"] = NATIONAL;
    try {
      const c = await connect();
      const added = await c.call("add_source", { kind: "rss", url: "https://nat.test/feed", name: "National tech" });
      expect(added.text).toContain("It published 2 item(s), but none of them mention Volta.");
      expect(added.text).toContain("Fetching again now would drop them again.");
      expect(added.text).toContain("To keep everything it publishes, say: keep everything from National tech.");
      expect(added.text).not.toContain("quiet");

      const prepared = await c.call("prepare_month", { force: true });
      expect(prepared.text).toContain("It published 2 item(s), but none of them mention Volta.");
      expect(prepared.text).not.toMatch(/search words may be too narrow/);

      // And his way out works, in his words.
      await c.call("set_source", { source_id: "cur_national-tech", keywords: [] });
      await c.call("prepare_month", { force: true });
      expect((await c.call("list_candidates")).text).toContain("Calgary fintech raises a seed round");
      await c.close();
    } finally {
      delete BODIES["https://nat.test/feed"];
    }
  });

  it("does not claim a calendar is filtered by the watchlist, since it never was", async () => {
    const c = await connect();
    const added = await c.call("add_source", { kind: "ics", url: "https://cal.test/ics", name: "Partner calendar", check: false });
    expect(added.text).toContain("keeps everything it publishes");
    expect(added.text).not.toContain("watchlist");
    expect((await c.call("list_sources")).text).toContain("Partner calendar");
    await c.close();
  });

  it("never promises to read a Slack channel it has just switched off", async () => {
    const c = await connect();
    const added = await c.call("add_source", { kind: "slack_channel", channel_id: "https://volta.slack.com/archives/C0C2H7WAUJX", name: "Member updates" });
    expect(added.text).toContain("left it switched off");
    expect(added.text).not.toContain("It will be read when this month is next prepared");
    await c.close();
  });
});

describe("what Bader is told about sources, wherever he reads it", () => {
  const NATIONAL = `<?xml version="1.0"?><rss version="2.0"><channel><title>National tech</title>
<item><title>Calgary fintech raises a seed round</title><link>https://nat.test/a</link><guid>a</guid><pubDate>Thu, 10 Sep 2026 09:00:00 GMT</pubDate><description>A Calgary company raised money.</description></item>
<item><title>Toronto biotech hires a chief scientist</title><link>https://nat.test/b</link><guid>b</guid><pubDate>Fri, 11 Sep 2026 09:00:00 GMT</pubDate><description>A Toronto company hired someone.</description></item>
</channel></rss>`;

  it("says the same thing in the reminder, the preparation and the draft when a feed is emptied", async () => {
    BODIES["https://nat.test/feed"] = NATIONAL;
    try {
      const c = await connect();
      await c.call("add_source", { kind: "rss", url: "https://nat.test/feed", name: "National tech", check: false });
      const prepared = await c.call("prepare_month", { force: true });
      const reminder = await c.call("monthly_reminder");

      const said = "It published 2 item(s), but none of them mention Volta.";
      expect(prepared.text).toContain(said);
      expect(reminder.text).toContain(said);
      expect(reminder.text).not.toContain("quiet month");
      expect(reminder.text).toContain("National tech"); // his name, never cur_national-tech
      await c.close();
    } finally {
      delete BODIES["https://nat.test/feed"];
    }
  });

  it("never says his own events source found nothing, in the reminder either", async () => {
    const c = await connect();
    await c.call("prepare_month");
    expect((await c.call("monthly_reminder")).text).not.toContain("manual-events");
    await c.close();
  });

  it("leaves a source that did its job out of the attention list", async () => {
    // Dropping the odd off-topic story is the filter working, not a problem to report.
    const c = await connect();
    const prepared = await c.call("prepare_month");
    expect(prepared.text).not.toContain("dropped as off-topic");
    await c.close();
  });

  it("says a calendar keeps everything, in the list and when it is turned off, not just when added", async () => {
    const c = await connect();
    await c.call("add_source", { kind: "ics", url: "https://cal.test/ics", name: "Partner calendar", check: false });
    expect((await c.call("list_sources")).text).toMatch(/Partner calendar[\s\S]*?keeps everything it publishes/);
    const off = await c.call("set_source", { source_id: "cur_partner-calendar", enabled: false });
    expect(off.text).toContain("keeps everything it publishes");
    expect(off.text).not.toContain("watchlist");
    await c.close();
  });
});

describe("what the curator is told, checked against what the month will really do", () => {
  it("counts what a calendar would keep, not what it published, when he gave it keywords", async () => {
    // QA: it said "Read it: 3 item(s), for example Labour Day" for a calendar filtered on "Volta".
    const c = await connect();
    const added = await c.call("add_source", { kind: "ics", url: "https://cal.test/ics", name: "Partner calendar", keywords: ["aquaculture"] });
    expect(added.text).toContain("none of them mention aquaculture.");
    expect(added.text).not.toMatch(/Read it: \d+ item/);
    await c.close();
  });

  it("treats an event that has already happened as past, however long ago the month was prepared", async () => {
    const c = await connect();
    await c.call("prepare_month"); // prepared 1 October; Demo Night was 17 September
    const list = await c.call("list_candidates");
    const upcoming = list.text.slice(list.text.indexOf("## Upcoming events"), list.text.indexOf("## Last month's events"));
    expect(upcoming).not.toContain("Demo Night");
    expect(list.text).toContain("held 2026-09-17");
    await c.close();
  });

  it("shows only the group he asked for, in the panel as well as the text", async () => {
    const c = await connect();
    await c.call("prepare_month");
    const r = (await c.client.callTool({ name: "list_candidates", arguments: { group: "upcoming" } })) as { structuredContent?: { groups: Array<{ key: string }> } };
    expect(r.structuredContent?.groups.map((g) => g.key)).toEqual(["upcoming"]);
    await c.close();
  });

  it("never tells him to change a setting only the maintainer can reach", async () => {
    const c = await connect({ mail: new FakeMail() });
    await c.call("prepare_month");
    await c.call("build_draft");
    const approved = await c.call("approve_draft", { draft_key: (await c.call("newsletter_status")).text.match(/key ([0-9a-f-]+)/)![1]! });
    expect(approved.text).toContain("This is a practice run");
    expect(approved.text).not.toContain("ALLOW_LIVE");
    const sent = await c.call("send_campaign", { campaign_id: "x", confirm: true });
    expect(sent.text).not.toContain("ALLOW_LIVE");
    await c.close();
  });

  it("dates a source by the day it was where Bader is, not in UTC", async () => {
    // 1 October 11:30 UTC is still 1 October in Halifax; the bug showed at 22:00 local (01:00 UTC).
    const c = await connect();
    await c.call("add_source", { kind: "rss", url: "https://news.test/rss", name: "QA date", check: false });
    expect((await c.call("list_sources")).text).toContain("added by you on 2026-10-01");
    await c.close();
  });
});

describe("a source that failed is not left looking healthy", () => {
  it("remembers the failed check and shows it in the list", async () => {
    const c = await connect();
    const added = await c.call("add_source", { kind: "rss", url: "https://nothing.test/feed", name: "Dead feed" });
    expect(added.text).toContain("could not be read");

    const list = await c.call("list_sources");
    expect(list.text).toMatch(/Dead feed[\s\S]*?last run: could not be read/);
    await c.close();
  });

  it("forgets the failure once the source works", async () => {
    const c = await connect();
    await c.call("add_source", { kind: "rss", url: "https://nothing.test/feed", name: "Sometimes down", check: true });
    BODIES["https://nothing.test/feed"] = `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
<item><title>Volta opens applications again</title><link>https://nothing.test/a</link><guid>a</guid><pubDate>Thu, 10 Sep 2026 09:00:00 GMT</pubDate><description>Volta opened applications.</description></item></channel></rss>`;
    try {
      await c.call("set_source", { source_id: "cur_sometimes-down", enabled: true });
      await c.call("prepare_month", { force: true });
      expect((await c.call("list_sources")).text).not.toMatch(/Sometimes down[\s\S]*?last run: could not be read/);
      await c.close();
    } finally {
      delete BODIES["https://nothing.test/feed"];
    }
  });
});

describe("a refresh, as Bader sees it afterwards", () => {
  const BARE_LI = `<html><body><a href="https://www.linkedin.com/posts/voltaeffect_still-time-to-get-in-on-this-one-the-activity-7507378018713600000-qA1x">x</a></body></html>`;

  it("unticks an item that is now marked for review, so the label is not hidden by a tick", async () => {
    BODIES["https://li.test/company"] = BARE_LI;
    try {
      const c = await connect();
      await c.call("add_source", { kind: "linkedin_company", url: "https://li.test/company", name: "Volta on LinkedIn", check: false });
      await c.call("prepare_month", { force: true });
      const list = await c.call("list_candidates");
      const id = /id: (cur_volta-on-linkedin:[^\s]+)/.exec(list.text)?.[1];
      expect(id, "the bare LinkedIn post should be a candidate").toBeDefined();

      // He ticks it anyway, then the month is fetched again: the review label must not be hidden.
      await c.call("set_selection", { select: [id!] });
      await c.call("prepare_month", { force: true });
      const after = await c.call("list_candidates");
      expect(after.text).toContain("0 of");
      expect(after.text).toContain("[ ] MARKED FOR REVIEW");
      await c.close();
    } finally {
      delete BODIES["https://li.test/company"];
    }
  });

  it("leaves the LinkedIn heading out rather than telling subscribers nothing was posted", async () => {
    BODIES["https://li.test/company"] = BARE_LI;
    try {
      const c = await connect();
      await c.call("add_source", { kind: "linkedin_company", url: "https://li.test/company", name: "Volta on LinkedIn", check: false });
      await c.call("prepare_month", { force: true });

      // The post is there, and held, because LinkedIn gave a link and no words. Held items are
      // never pre-ticked, so the section has nothing in it.
      const list = await c.call("list_candidates");
      expect(list.text).toContain("MARKED FOR REVIEW");
      expect(list.text).toMatch(/LinkedIn gave only the link/);

      const built = await c.call("build_draft");
      // It would be false to say nothing was posted, so the heading is simply absent.
      expect(built.text).not.toContain("Nothing from Volta on LinkedIn");
      expect(built.text).not.toContain("From Volta on LinkedIn");
      // And nothing else was swallowed: the news section has items, so it still prints them.
      expect(built.text).toContain("## In the news");
      await c.close();
    } finally {
      delete BODIES["https://li.test/company"];
    }
  });

  it("keeps his ticks and his wording when the calendar reissues its UIDs", async () => {
    // The promise prepare_month makes: "fetches again; Bader's edits and added events are kept".
    // Volta's calendar serves a fresh UID for the same event every time, so an id built from the
    // UID broke that promise on every refresh, silently.
    const saved = BODIES["https://cal.test/ics"]!;
    try {
      const c = await connect();
      await c.call("prepare_month");
      const mixer = /id: (volta-calendar:[^\s)]+)/.exec((await c.call("list_candidates")).text)?.[1];
      expect(mixer, "a calendar event should be listed").toBeDefined();

      await c.call("set_selection", { tick: [mixer!] });
      await c.call("edit_item", { item_id: mixer!, field: "summary", text: "Bader's own words about the mixer." });

      // The same calendar, served again with every UID rewritten.
      BODIES["https://cal.test/ics"] = saved.replace(/UID:(\w+)/g, "UID:$1-reissued");
      await c.call("prepare_month", { force: true });

      const after = await c.call("list_candidates");
      expect(after.text, "the same event, under the same id").toContain(mixer!);
      expect(after.text).toContain("[x]");
      expect(after.text).toContain("Bader's own words about the mixer.");
      expect(after.text).toContain("edited by Bader: description");
      await c.close();
    } finally {
      BODIES["https://cal.test/ics"] = saved;
    }
  });

  it("says a source's trouble once, however many warnings mean the same thing", async () => {
    BODIES["https://li.test/company"] = BARE_LI;
    try {
      const c = await connect();
      // Two warnings from one source ("fell back to permalinks" and "came with no text") say the
      // same thing to him.
      await c.call("add_source", { kind: "linkedin_company", url: "https://li.test/company", name: "Volta on LinkedIn", check: false });
      const prepared = await c.call("prepare_month", { force: true });
      const linkedIn = prepared.text.split("\n").filter((l) => l.includes("gave only links"));
      expect(linkedIn).toHaveLength(1);
      await c.close();
    } finally {
      delete BODIES["https://li.test/company"];
    }
  });
});
