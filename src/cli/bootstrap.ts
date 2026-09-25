/**
 * Everything the MCP server needs before it can answer a call, built from the environment alone:
 * paths, clock, config, storage, alerts, the email platform. No process-wide side effects — the
 * caller decides what to do with a problem — so the same function serves the stdio server, the
 * reminder command and a test that starts the real thing.
 */
import { ConsoleFileAlerter } from "../alerts.js";
import { resolveClock, type Clock } from "../clock.js";
import { loadConfig, type Config } from "../config.js";
import { fetchText } from "../http.js";
import { envFilesToLoad, resolvePaths, type PathOptions, type Paths } from "../install/paths.js";
import type { NewsletterDeps } from "../mcp/newsletter-server.js";
import { mailchimpFromEnv } from "../publish/mailchimp.js";
import { runWeek } from "../run-week.js";
import { liveClockProblem } from "../runtime.js";
import { brandFor, readSettings } from "../settings.js";
import { SqliteStorage } from "../storage.js";
import { startPreviewServer } from "../surface/preview-server.js";
import { loadDotEnv } from "./env.js";

/** A reason not to start, in one sentence the host's log will show. */
export class StartupProblem extends Error {}

export interface Bootstrap {
  deps: NewsletterDeps;
  config: Config;
  clock: Clock;
  storage: SqliteStorage;
  paths: Paths;
  /** Releases the preview port and the database. Safe to call once. */
  close(): Promise<void>;
}

/**
 * Loads the .env files that exist (working directory first, then the data directory) into
 * process.env. A variable already set in the environment is never overridden.
 */
export function loadEnvFiles(env: NodeJS.ProcessEnv, cwd: string, o: PathOptions = {}): string[] {
  const first = envFilesToLoad(cwd, resolvePaths(env, o).dataDir);
  for (const f of first) loadDotEnv(f);
  // The working directory's .env may itself name the data directory, so look there again.
  const after = envFilesToLoad(cwd, resolvePaths(env, o).dataDir).filter((f) => !first.includes(f));
  for (const f of after) loadDotEnv(f);
  return [...first, ...after];
}

export async function createDeps(o: { env: NodeJS.ProcessEnv; argv?: string[]; paths?: PathOptions; log?: (line: string) => void }): Promise<Bootstrap> {
  const { env } = o;
  const log = o.log ?? ((line: string) => console.error(`volta-newsletter: ${line}`));
  const paths = resolvePaths(env, o.paths ?? {});
  const clock = resolveClock(o.argv ?? [], env);
  const clockProblem = liveClockProblem(env, clock);
  if (clockProblem) throw new StartupProblem(clockProblem);

  const loaded = await loadConfig(paths.configPath);
  const storage = new SqliteStorage(paths.databasePath);
  // A timezone the curator saved wins over the packaged config's; it is read once, at start.
  const savedTz = readSettings(storage).timezone;
  const config = savedTz ? { ...loaded, timezone: savedTz } : loaded;
  const alerter = new ConsoleFileAlerter(paths.alertsLog, () => clock.now());

  const mail = mailchimpFromEnv(env, () => brandFor(storage).fromName);
  if (mail.problem) alerter.alert("error", "email", `the email platform is not configured: ${mail.problem}`, "approve will save the file only until it is; newsletter_status names the missing value");
  let audience: { audienceName: string; memberCount: number } | undefined;
  if (mail.publisher) {
    try {
      audience = await mail.publisher.verify();
    } catch (e) {
      alerter.alert("error", "email", `${mail.publisher.platform} is unreachable: ${(e as Error).message}`, "approve will say so; check the API key and audience id");
    }
  }

  let preview: Promise<{ put(html: string, id?: string): string; close(): Promise<void> } | undefined> | undefined;
  const outDir = paths.outDir;
  const deps: NewsletterDeps = {
    config, clock, storage, alerter, outDir, env,
    runPeriod: () => runWeek({ config, clock, storage, alerter, outDir }),
    fetchText,
    ...(mail.publisher ? { publisher: mail.publisher } : {}),
    ...(mail.problem ? { publisherProblem: mail.problem } : {}),
    ...(audience ? { audience } : {}),
    preview: () => (preview ??= startPreviewServer().catch((e: unknown) => {
      log(`preview not available: ${(e as Error).message}`);
      return undefined;
    })),
  };

  let closed = false;
  return {
    deps, config, clock, storage, paths,
    close: async () => {
      if (closed) return;
      closed = true;
      await (await preview)?.close().catch(() => undefined);
      storage.close();
    },
  };
}
