/**
 * Bolt Socket Mode wrapper: no public URL, runs on a laptop. Adapts Slack payloads to handlers.ts.
 * Requires SLACK_BOT_TOKEN (xoxb-) and SLACK_APP_TOKEN (xapp-, connections:write).
 */
import { App, LogLevel } from "@slack/bolt";
import type { Alerter } from "../alerts.js";
import { ACTION, selectedIdsFromState } from "./blocks.js";
import { approveDraft, generateDrafts, rememberSelection, sendCampaign, type SlackClient, type SurfaceState } from "./handlers.js";

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

  const log = (msg: string) => console.log(`${new Date().toISOString()} slack: ${msg}`);

  app.action(ACTION.select, async ({ ack, body }) => {
    await ack();
    const b = body as { channel?: { id: string }; state?: unknown };
    const ids = selectedIdsFromState(b.state);
    log(`selection changed: ${ids.length} ticked`);
    if (b.channel?.id) rememberSelection(st, b.channel.id, ids);
  });

  app.action(ACTION.generate, async ({ ack, body }) => {
    await ack();
    const b = body as { channel?: { id: string }; state?: unknown; message?: { ts: string } };
    const channel = b.channel?.id;
    if (!channel) return;
    const fromState = selectedIdsFromState(b.state);
    const ids = fromState.length ? fromState : st.selections.get(channel) ?? [];
    log(`Generate drafts pressed: ${ids.length} item(s) selected`);
    try {
      const good = await generateDrafts(client, channel, ids, st, alerter);
      log(`posted ${good.length} verified draft(s)`);
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
    log(`Approve pressed: draft ${draftId ?? "?"}`);
    if (!channel || !draftId) return;
    try {
      const paths = await approveDraft(client, channel, draftId, st);
      log(paths ? `approved and written: ${paths.html}` : "approve failed: draft not found in this session");
    } catch (e) {
      alerter.alert("error", "slack", `approve failed: ${(e as Error).message}`, "check the logs");
      await client.postMessage({ channel, text: `Could not approve: ${(e as Error).message}` });
    }
  });

  // A link button still posts an interaction; acknowledge it so Bolt does not warn.
  app.action(ACTION.preview, async ({ ack }) => {
    await ack();
    log("Preview opened in browser");
  });

  app.action(ACTION.send, async ({ ack, body }) => {
    await ack();
    const b = body as { channel?: { id: string }; actions?: Array<{ value?: string }> };
    const channel = b.channel?.id;
    const campaignId = b.actions?.[0]?.value;
    log(`Send pressed: campaign ${campaignId ?? "?"}`);
    if (!channel || !campaignId) return;
    try {
      const ok = await sendCampaign(client, channel, campaignId, st);
      log(ok ? `campaign ${campaignId} sent` : "send refused");
    } catch (e) {
      alerter.alert("error", "email", `send failed: ${(e as Error).message}`, "open the campaign in the email platform and send from there");
      await client.postMessage({ channel, text: `Could not send: ${(e as Error).message}` });
    }
  });

  return { app, client };
}
