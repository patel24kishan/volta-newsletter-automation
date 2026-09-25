/**
 * The reminder as an OS scheduler runs it: the same tool the app's task calls, in-process, plus
 * a desktop notification when something is due. Morning by morning, with a fake notifier.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryAlerter } from "../src/alerts.js";
import { runReminderCommand } from "../src/cli/reminder.js";
import type { Clock } from "../src/clock.js";
import type { Config } from "../src/config.js";
import { createNewsletterServer, type NewsletterDeps } from "../src/mcp/newsletter-server.js";
import type { Notifier } from "../src/reminder/notify.js";
import { runWeek } from "../src/run-week.js";
import { SqliteStorage } from "../src/storage.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const config: Config = {
  timezone: "America/Halifax", cadence: "monthly", draft_layout: "events-first", send_day: "monday", reminder_time: "08:30",
  content_window_days: 7, events_window_days: 14, watchlist: ["Volta"], holiday_overrides: [], alert_recipients: [],
  sources: [{ id: "manual-events", kind: "manual", type: "event", url: "", enabled: true, fallback_link: "https://voltaeffect.com/events" }],
};

class MovableClock implements Clock {
  overridden = true;
  label = "test";
  constructor(public current: Date) {}
  now() { return new Date(this.current.getTime()); }
  at(iso: string) { this.current = new Date(iso); }
}

class FakeNotifier implements Notifier {
  shown: Array<{ title: string; body: string }> = [];
  fail?: string;
  async notify(title: string, body: string) {
    if (this.fail) throw new Error(this.fail);
    this.shown.push({ title, body });
  }
}

let dir: string;
let storage: SqliteStorage;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "volta-remcmd-")); storage = new SqliteStorage(join(dir, "db.sqlite")); });
afterEach(() => { storage.close(); rmSync(dir, { recursive: true, force: true }); });

function deps(clock: Clock, route: NewsletterDeps["reminderRoute"] = "os-scheduler"): NewsletterDeps {
  const alerter = new MemoryAlerter();
  return {
    config, clock, storage, alerter, outDir: dir, env: { ALLOW_LIVE: "0" }, reminderRoute: route, platform: "win32",
    runPeriod: () => runWeek({ config, clock, storage, alerter, outDir: dir, fetchText: async () => "" }),
  };
}

async function run(clock: Clock, notifier = new FakeNotifier()) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runReminderCommand({ deps: deps(clock), notifier, stdout: (t) => out.push(t), stderr: (t) => err.push(t) });
  return { code, out: out.join("\n"), err: err.join("\n"), notifier };
}

/** newsletter_status as the chat would see it, on the same database. */
async function status(clock: Clock): Promise<string> {
  const server = createNewsletterServer(deps(clock, "claude-task"));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "chat", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const r = (await client.callTool({ name: "newsletter_status", arguments: {} })) as { content: Array<{ text: string }> };
  await client.close();
  return r.content[0]!.text;
}

describe("the reminder command, morning by morning", () => {
  it("says how to set itself up until it has run once, then when it last ran and by which route", async () => {
    const clock = new MovableClock(new Date("2026-10-01T11:29:00Z")); // 08:29 Halifax, Thursday 1 October
    const before = await status(clock);
    expect(before).toContain("Reminder: has never run on this computer, so nothing announces the month by itself.");
    expect(before).toContain('schtasks /Create /SC DAILY /ST 08:35 /TN "Volta newsletter reminder" /TR "cmd /c npx -y volta-newsletter reminder"');

    const quiet = await run(clock);
    expect(quiet.code).toBe(0);
    expect(quiet.out.split("\n")[0]).toBe("NOTHING_DUE");
    expect(quiet.notifier.shown).toEqual([]);
    expect(await status(clock)).toContain("Reminder last ran: 2026-10-01 08:29 Halifax time (the OS scheduler).");
  });

  it("notifies once when the month is due, and not again", async () => {
    const clock = new MovableClock(new Date("2026-10-01T11:35:00Z"));
    const due = await run(clock);
    expect(due.code).toBe(0);
    expect(due.out.split("\n")[0]).toBe("GREETING");
    expect(due.notifier.shown).toEqual([{
      title: "Volta Newsletter: October's newsletter is ready",
      body: 'Good morning. October\'s newsletter is prepared. Open your assistant and say: "Show me October\'s newsletter."',
    }]);
    const again = await run(clock);
    expect(again.out.split("\n")[0]).toBe("NOTHING_DUE");
    expect(again.notifier.shown).toEqual([]);
  });

  it("uses the saved names in the notification", async () => {
    storage.setSetting("organisation", "Acme", "2026-09-01T00:00:00Z");
    storage.setSetting("curator_name", "Sam", "2026-09-01T00:00:00Z");
    const due = await run(new MovableClock(new Date("2026-10-01T11:35:00Z")));
    expect(due.notifier.shown[0]).toEqual({
      title: "Acme Newsletter: October's newsletter is ready",
      body: 'Good morning Sam. October\'s newsletter is prepared. Open your assistant and say: "Show me October\'s newsletter."',
    });
  });

  it("notifies when a month was missed, once", async () => {
    const clock = new MovableClock(new Date("2026-10-12T15:00:00Z")); // past the 7-day catch-up
    const missed = await run(clock);
    expect(missed.code).toBe(0);
    expect(missed.out.split("\n")[0]).toBe("MISSED");
    expect(missed.notifier.shown).toHaveLength(1);
    expect(missed.notifier.shown[0]!.title).toBe("Volta Newsletter: October's reminder was missed");
    expect(missed.notifier.shown[0]!.body).toContain("could not be shown in time");
    expect((await run(clock)).notifier.shown).toEqual([]);
  });

  it("prints the reminder anyway and exits 1 when the notification cannot be shown", async () => {
    const n = new FakeNotifier();
    n.fail = "powershell.exe failed: no display";
    const r = await run(new MovableClock(new Date("2026-10-01T11:35:00Z")), n);
    expect(r.code).toBe(1);
    expect(r.out).toContain("GREETING");
    expect(r.err).toBe("volta-newsletter: could not show a notification: powershell.exe failed: no display. The reminder text is above.");
  });
});
