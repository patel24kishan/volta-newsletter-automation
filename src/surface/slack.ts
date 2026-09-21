/**
 * Bolt Socket Mode wrapper: no public URL, runs on a laptop. Adapts Slack payloads to handlers.ts.
 * Requires SLACK_BOT_TOKEN (xoxb-) and SLACK_APP_TOKEN (xapp-, connections:write).
 */
import { App, LogLevel } from "@slack/bolt";
import type { Alerter } from "../alerts.js";
import { validateManualEvent } from "../manual-events.js";
import { manualEventFromFields } from "../manual-events.js";
import { ACTION, ADD_EVENT, addEventErrorBlocks, addEventFields, addEventView, selectedIdsFromState } from "./blocks.js";
import { addManualEvent, approveDraft, changeItems, generateDrafts, rememberSelection, sendCampaign, type SlackClient, type SurfaceState } from "./handlers.js";

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
    async updateMessage(args) {
      await app.client.chat.update({ channel: args.channel, ts: args.ts, text: args.text, ...(args.blocks ? { blocks: args.blocks as never } : {}) });
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

  app.action(ACTION.addEvent, async ({ ack, body, client: bolt }) => {
    await ack();
    const b = body as { trigger_id?: string; channel?: { id: string }; message?: { ts: string }; state?: unknown };
    // Ticks live in the message, so remember them before the form takes over the screen.
    if (b.channel?.id) rememberSelection(st, b.channel.id, selectedIdsFromState(b.state));
    log("Add an event pressed");
    if (!b.trigger_id) return;
    try {
      await bolt.views.open({
        trigger_id: b.trigger_id,
        view: addEventView({ timeZone: st.timeZone, now: st.now?.() ?? new Date() }) as never,
      });
    } catch (e) {
      alerter.alert("error", "slack", `could not open the add-event form: ${(e as Error).message}`, "check the logs");
    }
  });

  app.view(ADD_EVENT.callbackId, async ({ ack, body, view }) => {
    const fields = addEventFields(view.state);
    // Slack closes the form only on a clean ack, so validate before acking and send errors back.
    const bodyUser = (body as { user?: { id?: string } }).user?.id;
    if (env.SLACK_BADER_USER_ID && bodyUser !== env.SLACK_BADER_USER_ID) {
      await ack({ response_action: "errors", errors: { [ADD_EVENT.field.title]: "Only the newsletter's curator can add an event." } } as never);
      log(`add-event refused: ${bodyUser ?? "unknown user"} is not the curator`);
      return;
    }
    const errors = validateManualEvent(manualEventFromFields(fields, st.timeZone), st.now?.() ?? new Date());
    if (Object.keys(errors).length) {
      await ack({ response_action: "errors", errors: addEventErrorBlocks(errors) } as never);
      log(`add-event rejected: ${Object.values(errors).join(" ")}`);
      return;
    }
    await ack();
    try {
      const { item } = await addManualEvent(client, fields, st);
      log(item ? `event added: "${item.title}" (${item.date})` : "event not added: it failed a second check");
    } catch (e) {
      alerter.alert("error", "slack", `could not add the event: ${(e as Error).message}`, "check the logs");
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

  app.action(ACTION.changeItems, async ({ ack, body }) => {
    await ack();
    log("Change the items pressed");
    try {
      await changeItems(client, st);
    } catch (e) {
      const channel = (body as { channel?: { id: string } }).channel?.id;
      alerter.alert("error", "slack", `could not re-post the candidate list: ${(e as Error).message}`, "scroll up to the list instead");
      if (channel) await client.postMessage({ channel, text: `Could not bring the list back: ${(e as Error).message}. Scroll up to the candidate list instead.` });
    }
  });

  // Link buttons still post interactions; acknowledge them so Bolt does not warn.
  app.action(ACTION.edit, async ({ ack }) => {
    await ack();
    log("Edit in email platform opened");
  });

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
