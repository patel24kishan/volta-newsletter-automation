/**
 * `volta-newsletter reminder`: the monthly reminder for hosts that cannot run it themselves. An
 * OS scheduler (Task Scheduler, cron, launchd) runs this every morning; it calls the very same
 * `monthly_reminder` tool the Claude app's task calls, through an in-process MCP client, so both
 * routes run one piece of logic and share the once-per-month marks. When something is due it
 * raises a desktop notification; on every other day it prints NOTHING_DUE and exits 0.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { cadenceOf } from "../config.js";
import { createNewsletterServer, type NewsletterDeps } from "../mcp/newsletter-server.js";
import { notifierFromEnv, type Notifier } from "../reminder/notify.js";
import { periodName } from "../review/reminder.js";
import { periodOf } from "../schedule/period.js";
import { brandFor } from "../settings.js";
import { createDeps, loadEnvFiles, StartupProblem } from "./bootstrap.js";

export interface ReminderRun {
  deps: NewsletterDeps;
  notifier: Notifier;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

/** Runs the reminder once. Returns the exit code: 0 whatever the tool decided, 1 if it or the notification failed. */
export async function runReminderCommand(o: ReminderRun): Promise<number> {
  const server = createNewsletterServer(o.deps);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "volta-newsletter reminder", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    let result: { content: Array<{ type: string; text?: string }>; isError?: boolean };
    try {
      result = (await client.callTool({ name: "monthly_reminder", arguments: {} })) as typeof result;
    } catch (e) {
      o.stderr(`volta-newsletter: the reminder could not run: ${(e as Error).message}`);
      return 1;
    }
    const text = result.content.map((c) => c.text ?? "").join("\n");
    o.stdout(text);
    if (result.isError) {
      o.stderr("volta-newsletter: the reminder could not run; the reason is above.");
      return 1;
    }

    const [first = "", ...rest] = text.split("\n");
    const name = periodName(periodOf(o.deps.clock.now(), o.deps.config).key, cadenceOf(o.deps.config));
    const newsletter = brandFor(o.deps.storage).newsletter;
    let title: string;
    let body: string;
    if (first === "GREETING") {
      title = `${newsletter}: ${name}'s newsletter is ready`;
      body = `${rest[0] ?? ""} Open your assistant and say: "Show me ${name}'s newsletter."`;
    } else if (first === "MISSED") {
      title = `${newsletter}: ${name}'s reminder was missed`;
      body = rest.join(" ").trim();
    } else {
      return 0;
    }
    try {
      await o.notifier.notify(title, body);
    } catch (e) {
      o.stderr(`volta-newsletter: could not show a notification: ${(e as Error).message}. The reminder text is above.`);
      return 1;
    }
    return 0;
  } finally {
    await client.close();
    await server.close().catch(() => undefined);
  }
}

/** The command as main.ts runs it: environment in, exit code out. */
export async function reminderMain(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv.slice(2).filter((a) => a !== "reminder")): Promise<number> {
  loadEnvFiles(env, process.cwd());
  let boot;
  try {
    boot = await createDeps({ env, argv, reminderRoute: "os-scheduler" });
  } catch (e) {
    if (e instanceof StartupProblem) {
      console.error(`volta-newsletter: ${e.message}`);
      return 1;
    }
    throw e;
  }
  try {
    return await runReminderCommand({
      deps: boot.deps,
      notifier: notifierFromEnv(env),
      stdout: (t) => process.stdout.write(`${t}\n`),
      stderr: (t) => process.stderr.write(`${t}\n`),
    });
  } finally {
    await boot.close();
  }
}
