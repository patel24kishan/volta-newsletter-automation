/**
 * Everything both the demo and the always-on service do to bring the Slack side up, in the one
 * order that works. Shared so the two cannot drift: a step one of them forgot, such as loading the
 * campaigns awaiting Send, would only show up as a button that stopped working after a restart.
 *
 * It neither runs the week nor sends anything: the demo sends once, the service on a schedule.
 */
import type { App } from "@slack/bolt";
import type { Alerter } from "../alerts.js";
import type { Clock } from "../clock.js";
import type { Config } from "../config.js";
import type { RankedItem } from "../pipeline/rank.js";
import { mailchimpFromEnv } from "../publish/mailchimp.js";
import type { RunSummary } from "../run-week.js";
import { addDays } from "../schedule/first-workday.js";
import { effectiveSources } from "../sources/curator-sources.js";
import type { SqliteStorage } from "../storage.js";
import type { ReminderInput } from "../surface/blocks.js";
import type { SlackClient, SurfaceState } from "../surface/handlers.js";
import { startPreviewServer, type PreviewServer } from "../surface/preview-server.js";
import { loadCampaigns, loadReview, restoreSession, type SessionSnapshot } from "../surface/session.js";
import { createSlackApp } from "../surface/slack.js";

export interface SurfaceOptions {
  config: Config;
  clock: Clock;
  env: NodeJS.ProcessEnv;
  storage: SqliteStorage;
  alerter: Alerter;
  outDir: string;
  /** A fresh run's candidates, or none when a saved review is about to be restored. */
  candidates: RankedItem[];
  week: string;
  restored?: SessionSnapshot;
  /** The service carries on without email if Mailchimp is unreachable; the demo stops, as it always has. */
  tolerateEmailOutage: boolean;
  queue: (work: () => Promise<void>) => Promise<void>;
}

export interface Surface {
  st: SurfaceState;
  client: SlackClient;
  app: App;
  /** Try again to reach an email platform that was unreachable at startup. Does nothing once connected. */
  retryEmail(): Promise<void>;
  /** Re-read the audience count, which drifts over the weeks a service keeps running. */
  refreshAudience(): Promise<void>;
  /** Stop taking clicks. Called first on shutdown. */
  stopSlack(): Promise<void>;
  closePreview(): Promise<void>;
}

const log = (msg: string) => console.log(msg);

export async function startSurface(o: SurfaceOptions): Promise<Surface> {
  const { config, clock, env, storage, alerter } = o;
  const st: SurfaceState = {
    candidates: o.candidates, timeZone: config.timezone, outDir: o.outDir, drafts: new Map(), selections: new Map(),
    env, campaigns: new Set(), now: () => clock.now(), layout: config.draft_layout, session: storage, week: o.week,
    ...(config.cadence ? { cadence: config.cadence } : {}),
  };

  // Campaigns are kept across weeks, so one approved before a restart can still be sent after it.
  loadCampaigns(st, storage);
  if (st.campaigns.size) log(`email: ${st.campaigns.size} approved campaign(s) not yet sent`);

  // Serves the rendered email so Slack can link to the real thing, not Slack's approximation of it.
  let preview: PreviewServer | undefined;
  try {
    preview = await startPreviewServer();
    st.preview = preview;
    log(`preview: serving the rendered newsletter at ${preview.baseUrl}${env.PUBLIC_URL ? "" : " (this machine only)"}`);
  } catch (e) {
    log(`preview: not available (${(e as Error).message}); Slack will show the draft without a preview button`);
  }

  // After the preview server, so the draft's page is served again at the address Bader already has.
  if (o.restored) restoreSession(st, o.restored);

  const manual = effectiveSources(config, storage).find((s) => s.kind === "manual" && s.enabled);
  if (manual?.fallback_link) {
    st.storage = storage;
    st.manualSource = { ...manual, fallback_link: manual.fallback_link };
  } else {
    log('events: no enabled "manual" source in config, so the Add an event button will not work');
  }

  // A misconfigured key throws here for both commands: that is a mistake to fix, not an outage.
  const { publisher: pending, problem: mailProblem } = mailchimpFromEnv(env);
  if (mailProblem) throw new Error(mailProblem);
  let alertedOutage = false;
  const connectEmail = async (): Promise<void> => {
    if (!pending || st.publisher) return;
    try {
      st.audience = await pending.verify();
      st.publisher = pending;
      log(`email: ${pending.platform} connected, audience "${st.audience.audienceName}" (${st.audience.memberCount} contacts)`);
    } catch (e) {
      if (!o.tolerateEmailOutage) throw e;
      // Crashing would restart the container into the same outage, again and again.
      if (!alertedOutage) alerter.alert("error", "email", `${pending.platform} is unreachable: ${(e as Error).message}`, "Approve will stop at the saved file until it is back; retried every few minutes");
      alertedOutage = true;
    }
  };
  if (pending) await connectEmail();
  else log("email: not configured (MAILCHIMP_API_KEY / MAILCHIMP_LIST_ID unset); Approve stops at out/final.html");

  // Last: clicks can arrive the moment this connects, so everything above must already be in place.
  const { app, client } = createSlackApp(env, st, alerter, o.queue);
  await app.start();
  log("connected to Slack (Socket Mode)");

  return {
    st, client, app,
    retryEmail: connectEmail,
    async refreshAudience() {
      if (st.publisher) st.audience = await st.publisher.verify();
    },
    async stopSlack() {
      await app.stop();
    },
    async closePreview() {
      await preview?.close();
    },
  };
}

/** What the reminder shows, from a finished weekly run. */
export function reminderInputFrom(run: RunSummary, config: Config, clockLabel: string): ReminderInput {
  return {
    candidates: run.candidates, preselectedIds: run.preselected_ids, firstWorkday: run.first_workday,
    timeZone: config.timezone, clockLabel, period: run.period,
    sourceNotes: run.sources.filter((s) => s.status !== "ok").map((s) => `${s.id}: ${s.status}${s.error ? ` (${s.error})` : ""}`),
  };
}

/**
 * The review to pick up at startup: this week's, or with `fallBackAWeek`, last week's while this
 * week has none. Without that, restarting the service early on a Monday would make last week's
 * list stop working hours before the new one arrives, when without a restart it would not.
 */
export function pickUpReview(
  storage: Pick<SqliteStorage, "loadSession">,
  week: string,
  opts: { fallBackAWeek: boolean },
): { snapshot?: SessionSnapshot; week: string; error?: string } {
  const current = loadReview(storage, week);
  if (current && "snapshot" in current) return { snapshot: current.snapshot, week };
  if (current && "error" in current) return { week, error: current.error };
  if (opts.fallBackAWeek) {
    const previousWeek = addDays(week, -7);
    const previous = loadReview(storage, previousWeek);
    if (previous && "snapshot" in previous) return { snapshot: previous.snapshot, week: previousWeek };
  }
  return { week };
}

/**
 * Why the always-on service must not start as configured, or undefined if it may. Both cases fail
 * silently otherwise: a fixed clock never reaches the reminder, and a database on the container's
 * own disk is wiped by every deploy, after which the week looks unsent and the reminder goes again.
 */
export function serveEnvironmentProblem(env: NodeJS.ProcessEnv, clock: Pick<Clock, "overridden">): string | undefined {
  const live = env.ALLOW_LIVE === "1";
  if (live && clock.overridden) {
    return "refusing to start live with the clock overridden (--now or DEMO_NOW): the service would never reach the reminder time. Unset it, or rehearse without ALLOW_LIVE=1.";
  }
  if (live && !env.DATABASE_PATH) {
    return "refusing to start live without DATABASE_PATH: set it to a file on a persistent volume, or every deploy would forget the week and send the reminder again.";
  }
  return undefined;
}
