/**
 * Integration: the first-run set-up, as a friend's assistant would drive it. A fresh database
 * says it is not set up; the tool previews without saving; saving changes the subject of the
 * very next draft with no restart; and a second server on the same database still sees it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryAlerter } from "../src/alerts.js";
import { resolveClock } from "../src/clock.js";
import type { Config } from "../src/config.js";
import { createNewsletterServer, INSTRUCTIONS } from "../src/mcp/newsletter-server.js";
import { runWeek } from "../src/run-week.js";
import { SqliteStorage } from "../src/storage.js";

const config: Config = {
  timezone: "America/Halifax", cadence: "monthly", draft_layout: "events-first", send_day: "monday", reminder_time: "08:30",
  content_window_days: 7, events_window_days: 14, watchlist: ["Acme"], holiday_overrides: [], alert_recipients: [],
  sources: [
    { id: "cal", kind: "ics", type: "event", url: "https://cal.test/ics", enabled: true },
    { id: "manual-events", kind: "manual", type: "event", url: "", enabled: true, fallback_link: "https://acme.test/events" },
  ],
};
const BODIES: Record<string, string> = {
  "https://cal.test/ics": ["BEGIN:VCALENDAR", "VERSION:2.0",
    "BEGIN:VEVENT", "UID:mixer", "SUMMARY:Fall Mixer", "DTSTART:20261022T210000Z", "DTEND:20261022T230000Z", "URL:https://www.eventbrite.ca/e/mixer", "DESCRIPTION:Meet the fall cohort.", "LOCATION:Acme HQ", "END:VEVENT",
    "END:VCALENDAR"].join("\r\n"),
};
const clock = resolveClock(["--now=2026-10-01T11:30:00Z"], {});

let dir: string;
let storage: SqliteStorage;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "volta-setup-")); storage = new SqliteStorage(join(dir, "db.sqlite")); });
afterEach(() => { storage.close(); rmSync(dir, { recursive: true, force: true }); });

async function connect() {
  const server = createNewsletterServer({
    config, clock, storage, alerter: new MemoryAlerter(), outDir: dir, env: { ALLOW_LIVE: "0" },
    runPeriod: () => runWeek({ config, clock, storage, alerter: new MemoryAlerter(), outDir: dir, fetchText: async (u) => BODIES[u] ?? "" }),
    preview: async () => ({ put: (_html: string, id?: string) => `http://127.0.0.1:3111/preview/${id ?? "x"}` }),
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
    return { text: r.content.map((c) => c.text).join("\n"), isError: Boolean(r.isError) };
  };
  return { call, close: () => client.close() };
}

describe("setting up the newsletter for someone who is not Volta", () => {
  it("is offered by status, previews before saving, applies at once, and survives a restart", async () => {
    const c = await connect();
    expect((await c.call("newsletter_status")).text).toMatch(/^Not set up yet: running as "Volta" with no curator name\. Say "set up the newsletter"/);
    expect(INSTRUCTIONS).toMatch(/offer once to set it up with set_up_newsletter/);
    expect(INSTRUCTIONS).toMatch(/Credentials .* are never asked for or typed in this chat/);

    // Nothing without the organisation and a name; nothing is saved by a preview.
    const refused = await c.call("set_up_newsletter", { organisation: "Acme" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("Your name is needed");
    const preview = await c.call("set_up_newsletter", { organisation: "Acme", curator_name: "Sam" });
    expect(preview.isError).toBe(false);
    expect(preview.text).toContain("This would set:");
    expect(preview.text).toContain("- Organisation: Acme (was Volta)");
    expect(preview.text).toContain("Nothing is saved yet");
    expect((await c.call("newsletter_status")).text).toMatch(/^Not set up yet/);

    // Saved: the next status, list and draft all speak as Acme, with no restart.
    const saved = await c.call("set_up_newsletter", { organisation: "Acme", curator_name: "Sam", confirm: true });
    expect(saved.text).toMatch(/^Saved\. It applies from now; nothing to restart\./);
    expect((await c.call("newsletter_status")).text).toMatch(/^Newsletter: Acme Newsletter \(Acme\), curator Sam\./);
    await c.call("prepare_month");
    const built = await c.call("build_draft");
    expect(built.text).toContain("Acme this month: October 2026");
    expect(built.text).not.toContain("Volta");
    expect(built.text).toContain("Verified: every name, date and link traces to a source or to the curator.");
    await c.close();

    // A new server on the same database: still Acme, and the reminder greets Sam.
    const again = await connect();
    expect((await again.call("newsletter_status")).text).toMatch(/^Newsletter: Acme Newsletter \(Acme\), curator Sam\./);
    expect((await again.call("monthly_reminder")).text).toMatch(/^GREETING\nGood morning Sam\. October's newsletter is prepared\./);
    // Only the name changes; the organisation stays.
    await again.call("set_up_newsletter", { curator_name: "Alex", confirm: true });
    expect((await again.call("newsletter_status")).text).toMatch(/^Newsletter: Acme Newsletter \(Acme\), curator Alex\./);
    await again.close();
  });

  it("keeps Volta, and greets no one by name, when nothing has been set", async () => {
    const c = await connect();
    await c.call("prepare_month");
    expect((await c.call("build_draft")).text).toContain("Volta this month: October 2026");
    expect((await c.call("monthly_reminder")).text).toMatch(/^GREETING\nGood morning\. October's newsletter is prepared\./);
    await c.close();
  });
});
