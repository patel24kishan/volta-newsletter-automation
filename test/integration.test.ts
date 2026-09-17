/**
 * Integration tests: the whole chain wired together, not mocked apart.
 *
 * Real code under test: fetchers -> storage -> dedupe -> summarize -> rank -> templates ->
 * verifier -> Slack block builders -> handlers -> preview server (a real HTTP server) ->
 * publisher. Only the network (fetchText), Slack transport, and the email platform are faked,
 * because those are the three things we must not actually touch in a test.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryAlerter } from "../src/alerts.js";
import { resolveClock } from "../src/clock.js";
import type { Config } from "../src/config.js";
import { runWeek } from "../src/run-week.js";
import { SqliteStorage } from "../src/storage.js";
import { ACTION, selectedIdsFromState } from "../src/surface/blocks.js";
import { approveDraft, generateDrafts, sendCampaign, sendReminder, type SlackClient, type SurfaceState } from "../src/surface/handlers.js";
import { startPreviewServer, type PreviewServer } from "../src/surface/preview-server.js";
import type { Publisher } from "../src/publish/types.js";
import { verifyDraft } from "../src/pipeline/verify.js";
import { TEMPLATE_PHRASES } from "../src/draft/templates.js";

const config: Config = {
  timezone: "America/Halifax", send_day: "monday", reminder_time: "08:30", content_window_days: 7, events_window_days: 14,
  watchlist: ["Volta"], holiday_overrides: ["2026-10-12"], alert_recipients: ["bader"],
  sources: [
    { id: "google-news", kind: "rss", type: "news", url: "https://news.test/rss", enabled: true },
    { id: "volta-calendar", kind: "ics", type: "event", url: "https://cal.test/ics", enabled: true, fallback_link: "https://voltaeffect.com/events" },
    { id: "volta-linkedin", kind: "linkedin_company", type: "linkedin", url: "https://li.test/company", enabled: true },
  ],
};

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
<item><title>Volta Launches New AI-Focused Program - Entrevestor</title><link>https://news.test/a</link><guid>a</guid><pubDate>Mon, 14 Sep 2026 10:00:00 GMT</pubDate><description>Volta launched a new program for founders. It starts in October.</description></item>
</channel></rss>`;
const ICS = ["BEGIN:VCALENDAR", "VERSION:2.0",
  "BEGIN:VEVENT", "UID:yoga", "SUMMARY:Yoga", "DTSTART:20260924T104500Z", "DTEND:20260924T114500Z", "URL:https://www.eventbrite.ca/e/yoga", "DESCRIPTION:Join us for a 1-hour guided yoga session.", "LOCATION:Volta", "END:VEVENT",
  "BEGIN:VEVENT", "UID:mixer", "SUMMARY:AI Showcase and Mixer", "DTSTART:20260916T210000Z", "DTEND:20260916T230000Z", "URL:https://www.eventbrite.ca/e/mixer", "DESCRIPTION:An evening of showcasing AI applications.", "LOCATION:Volta", "END:VEVENT",
  "END:VCALENDAR"].join("\r\n");
const LI = `<html><head><script type="application/ld+json">${JSON.stringify({ "@graph": [{ "@type": "DiscussionForumPosting", datePublished: "2026-09-15T16:01:07Z", url: "https://www.linkedin.com/posts/voltaeffect_yoga-activity-7505656961221419008-q", text: "Will we see you next Thursday? On September 24, join us for a 1-hour guided yoga session." }] })}</script></head></html>`;

const bodies: Record<string, string> = { "https://news.test/rss": RSS, "https://cal.test/ics": ICS, "https://li.test/company": LI };
const fetchText = async (url: string) => {
  const b = bodies[url];
  if (b === undefined) throw new Error(`GET ${url} returned HTTP 503`);
  return b;
};

class FakeSlack implements SlackClient {
  posts: Array<{ channel: string; text: string; blocks?: unknown[] }> = [];
  async postMessage(args: { channel: string; text: string; blocks?: unknown[] }) { this.posts.push(args); return { ts: `${this.posts.length}.0`, channel: args.channel }; }
  async openDm(userId: string) { return `D_${userId}`; }
  /** Every button across every message posted so far. */
  buttons(): Array<{ action_id: string; url?: string; value?: string }> {
    return this.posts.flatMap((p) => (p.blocks ?? []).flatMap((b) => {
      const blk = b as { type?: string; elements?: Array<{ action_id: string; url?: string; value?: string }> };
      return blk.type === "actions" ? blk.elements ?? [] : [];
    }));
  }
}

class FakeMailchimp implements Publisher {
  readonly platform = "Mailchimp";
  campaigns = new Map<string, string>();
  sent: string[] = [];
  async verify() { return { audienceName: "Volta demo", memberCount: 2 }; }
  async publishDraft(d: { id: string; html: string }) {
    const id = `camp_${d.id}`;
    this.campaigns.set(id, d.html);
    return { id, editUrl: `https://us21.admin.mailchimp.com/campaigns/edit?id=${id}`, platform: this.platform };
  }
  async send(id: string) {
    if (!this.campaigns.has(id)) throw new Error(`unknown campaign ${id}`);
    this.sent.push(id);
  }
}

describe("end-to-end: fetch through Slack approval, preview and send", () => {
  let outDir: string;
  let storage: SqliteStorage;
  let preview: PreviewServer;

  beforeEach(async () => {
    outDir = mkdtempSync(join(tmpdir(), "volta-int-"));
    storage = new SqliteStorage(":memory:");
    preview = await startPreviewServer(0); // any free port, so a running demo never blocks the test
  });
  afterEach(async () => {
    storage.close();
    await preview.close();
    rmSync(outDir, { recursive: true, force: true });
  });

  it("runs the full weekly cycle, then Bader's two decisions, and the newsletter reaches the email platform", async () => {
    const clock = resolveClock(["--now=2026-09-15T18:00:00Z"], {});
    const alerter = new MemoryAlerter();
    const slack = new FakeSlack();
    const mailchimp = new FakeMailchimp();

    // --- The unattended part: everything up to the reminder ---
    const run = await runWeek({ config, clock, storage, alerter, outDir, fetchText });
    expect(run.sources.every((s) => s.status === "ok")).toBe(true);
    expect(run.fetched).toBe(4);
    expect(run.after_dedupe).toBe(3); // the LinkedIn yoga post folds into the Yoga event
    expect(run.drafts.every((d) => d.verified)).toBe(true);

    const st: SurfaceState = {
      candidates: run.candidates, timeZone: config.timezone, outDir,
      drafts: new Map(), selections: new Map(), env: { ALLOW_LIVE: "1" },
      campaigns: new Set(), preview, publisher: mailchimp, audience: await mailchimp.verify(),
    };

    // --- Reminder ---
    const { channel } = await sendReminder(slack, "U_BADER", {
      candidates: run.candidates, preselectedIds: run.preselected_ids, firstWorkday: run.first_workday,
      timeZone: config.timezone, clockLabel: clock.label, sourceNotes: [],
    }, st);
    expect(channel).toBe("D_U_BADER");
    expect(slack.posts).toHaveLength(1);

    // --- Decision one: Bader's selection, read back the way Slack sends it ---
    const ticked = run.candidates.slice(0, 2).map((c) => c.item.id);
    const fromSlackPayload = selectedIdsFromState({ values: { select_0: { [ACTION.select]: { selected_options: ticked.map((v) => ({ value: v })) } } } });
    expect(fromSlackPayload).toEqual(ticked);

    const drafts = await generateDrafts(slack, channel, fromSlackPayload, st, alerter);
    expect(drafts.map((d) => d.id)).toEqual(["brief", "standard", "events-first"]);
    expect(alerter.sent).toEqual([]); // nothing was withheld

    // Each draft is previewable in a browser, and the served page is that draft's real HTML.
    for (const d of drafts) {
      const btn = slack.buttons().find((b) => b.url?.endsWith(`/preview/draft-${d.id}`));
      expect(btn, d.id).toBeDefined();
      const res = await fetch(btn!.url!);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      expect(await res.text()).toBe(d.html);
    }

    // --- Decision two: approve, then send ---
    const chosen = drafts[1]!; // Standard
    const paths = await approveDraft(slack, channel, chosen.id, st);
    expect(paths).toBeDefined();
    expect(existsSync(paths!.html)).toBe(true);
    expect(readFileSync(paths!.html, "utf8")).toBe(chosen.html);

    const approvalButtons = (slack.posts.at(-1)!.blocks!.at(-1) as { elements: Array<{ action_id: string; url?: string; value?: string }> }).elements;
    expect(approvalButtons.map((b) => b.action_id)).toEqual([ACTION.preview, ACTION.edit, ACTION.send]);

    // Preview serves the approved newsletter; Edit points at the real campaign.
    expect(await (await fetch(approvalButtons[0]!.url!)).text()).toBe(chosen.html);
    const campaignId = approvalButtons[2]!.value!;
    expect(approvalButtons[1]!.url).toContain(campaignId);
    expect(mailchimp.campaigns.get(campaignId)).toBe(chosen.html);

    expect(await sendCampaign(slack, channel, campaignId, st)).toBe(true);
    expect(mailchimp.sent).toEqual([campaignId]);

    // --- The promise of the whole system: nothing in what was sent was invented ---
    // Re-verified here independently of buildDrafts, allowing only the templates' own fixed phrases.
    const selectedItems = ticked.map((id) => run.candidates.find((c) => c.item.id === id)!.item);
    const reVerified = verifyDraft(chosen.markdown, selectedItems, { timeZone: config.timezone, allow: TEMPLATE_PHRASES });
    expect(reVerified.violations, JSON.stringify(reVerified.violations)).toEqual([]);
    expect(reVerified.checked.links).toBeGreaterThan(0);
    const sentHtml = mailchimp.campaigns.get(campaignId)!;
    for (const link of sentHtml.match(/href="([^"]+)"/g) ?? []) {
      const url = link.slice(6, -1);
      const known = selectedItems.some((i) => i.link === url || (i.related ?? []).some((r) => r.link === url));
      expect(known, `link not traceable to a source item: ${url}`).toBe(true);
    }
  });

  it("a broken source alerts, is named in the draft, and never blocks the rest of the newsletter", async () => {
    const clock = resolveClock(["--now=2026-09-15T18:00:00Z"], {});
    const alerter = new MemoryAlerter();
    const broken: Config = { ...config, sources: config.sources.map((s) => (s.id === "google-news" ? { ...s, url: "https://news.test/down" } : s)) };

    const run = await runWeek({ config: broken, clock, storage, alerter, outDir, fetchText });

    expect(run.sources.find((s) => s.id === "google-news")!.status).toBe("failed");
    expect(alerter.sent.some((a) => a.level === "error" && a.source === "google-news" && /503/.test(a.message))).toBe(true);
    // The other two sources still produced a verified newsletter.
    expect(run.after_dedupe).toBeGreaterThan(0);
    expect(run.drafts.every((d) => d.verified)).toBe(true);
    expect(readFileSync(run.drafts[1]!.file_md, "utf8")).toContain("No in the news items this week.");
  });

  it("dry-run reaches nobody: no Slack message, no campaign, no send", async () => {
    const clock = resolveClock(["--now=2026-09-15T18:00:00Z"], {});
    const slack = new FakeSlack();
    const mailchimp = new FakeMailchimp();
    const run = await runWeek({ config, clock, storage, alerter: new MemoryAlerter(), outDir, fetchText });

    const st: SurfaceState = {
      candidates: run.candidates, timeZone: config.timezone, outDir, drafts: new Map(), selections: new Map(),
      env: {}, campaigns: new Set(), preview, publisher: mailchimp, audience: { audienceName: "Volta demo", memberCount: 2 },
    };

    await expect(sendReminder(slack, "U_BADER", { candidates: run.candidates, preselectedIds: [], firstWorkday: run.first_workday, timeZone: config.timezone, clockLabel: clock.label, sourceNotes: [] }, st)).rejects.toThrow(/dry-run/);
    await expect(generateDrafts(slack, "D1", [run.candidates[0]!.item.id], st, new MemoryAlerter())).rejects.toThrow(/dry-run/);
    await expect(sendCampaign(slack, "D1", "camp_x", st)).rejects.toThrow(/dry-run/);

    expect(slack.posts).toEqual([]);
    expect(mailchimp.campaigns.size).toBe(0);
    expect(mailchimp.sent).toEqual([]);
    // The drafts still exist on disk: dry-run gathers and drafts, it just never reaches a human.
    expect(existsSync(join(outDir, "drafts", "standard.html"))).toBe(true);
  });

  it("the same week run twice is idempotent: no duplicate stored items", async () => {
    const clock = resolveClock(["--now=2026-09-15T18:00:00Z"], {});
    const first = await runWeek({ config, clock, storage, alerter: new MemoryAlerter(), outDir, fetchText });
    const countAfterFirst = storage.countItems();
    const second = await runWeek({ config, clock, storage, alerter: new MemoryAlerter(), outDir, fetchText });
    expect(storage.countItems()).toBe(countAfterFirst);
    expect(second.candidates.map((c) => c.item.id)).toEqual(first.candidates.map((c) => c.item.id));
  });
});
