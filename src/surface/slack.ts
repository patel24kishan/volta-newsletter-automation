/**
 * Bolt Socket Mode wrapper: no public URL, runs on a laptop. Adapts Slack payloads to handlers.ts.
 * Requires SLACK_BOT_TOKEN (xoxb-) and SLACK_APP_TOKEN (xapp-, connections:write).
 */
import { App, LogLevel } from "@slack/bolt";
import type { Alerter } from "../alerts.js";
import { ACTION, selectedIdsFromState } from "./blocks.js";
import { approveDraft, generateDrafts, rememberSelection, type SlackClient, type SurfaceState } from "./handlers.js";

export function createSlackApp(env: NodeJS.ProcessEnv, st: SurfaceState, alerter: Alerter): { app: App; client: SlackClient } {
  const botToken = env.SLACK_BOT_TOKEN;
  const appToken = env.SLACK_APP_TOKEN;
  if (!botToken || !appToken) throw new Error("SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set in .env (see slack/manifest.json and README steps)");

  const app = new App({ token: botToken, appToken, socketMode: true, logLevel: LogLevel.WARN });

  const client: SlackClient = {
    async postMessage(args) {
      const r = await app.client.chat.postMessage({
        channel: args.channel,
        text: args.text,
        ...(args.blocks ? { blocks: args.blocks as never } : {}),
        ...(args.thread_ts ? { thread_ts: args.thread_ts } : {}),
      });
      return { ...(r.ts ? { ts: r.ts } : {}), ...(r.channel ? { channel: r.channel } : {}) };
    },
    async openDm(userId) {
      const r = await app.client.conversations.open({ users: userId });
      const id = r.channel?.id;
      if (!id) throw new Error(`could not open a DM with ${userId}`);
      return id;
    },
  };

  app.action(ACTION.select, async ({ ack, body }) => {
    await ack();
    const b = body as { channel?: { id: string }; state?: unknown };
    if (b.channel?.id) rememberSelection(st, b.channel.id, selectedIdsFromState(b.state));
  });

  app.action(ACTION.generate, async ({ ack, body }) => {
    await ack();
    const b = body as { channel?: { id: string }; state?: unknown; message?: { ts: string } };
    const channel = b.channel?.id;
    if (!channel) return;
    const fromState = selectedIdsFromState(b.state);
    const ids = fromState.length ? fromState : st.selections.get(channel) ?? [];
    try {
      await generateDrafts(client, channel, ids, st, alerter);
    } catch (e) {
      alerter.alert("error", "slack", `generate failed: ${(e as Error).message}`, "check the logs");
      await client.postMessage({ channel, text: `Could not generate drafts: ${(e as Error).message}` });
    }
  });

  app.action(ACTION.approve, async ({ ack, body }) => {
    await ack();
    const b = body as { channel?: { id: string }; actions?: Array<{ value?: string }> };
    const channel = b.channel?.id;
    const draftId = b.actions?.[0]?.value;
    if (!channel || !draftId) return;
    try {
      await approveDraft(client, channel, draftId, st);
    } catch (e) {
      alerter.alert("error", "slack", `approve failed: ${(e as Error).message}`, "check the logs");
      await client.postMessage({ channel, text: `Could not approve: ${(e as Error).message}` });
    }
  });

  return { app, client };
}
