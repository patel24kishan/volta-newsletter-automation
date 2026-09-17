/**
 * Slack channel fetcher. The member-social source from the plan (C5): members drop links to
 * where they have appeared into one channel, and the pipeline reads that channel each week.
 *
 * This is deliberately not social-media monitoring. There is no compliant, free way to watch
 * other people's LinkedIn or Instagram posts, so the channel is the source of truth and the
 * submitter's own note is the summary. Nothing is inferred about a link that was not said.
 *
 * Needs bot scopes: channels:history and channels:read for a public channel (groups:history for
 * a private one), plus users:read to name the submitter.
 */
import type { SourceConfig } from "../config.js";
import { isAbsoluteHttpUrl, itemId, type Item } from "../schema.js";
import { collapseWhitespace, decodeEntities, firstSentences } from "../text.js";
import type { FetchContext, FetchResult, Fetcher } from "./types.js";

/** Slack wraps links as <https://x> or <https://x|label>. */
const SLACK_LINK = /<(https?:\/\/[^|>\s]+)(?:\|([^>]*))?>/g;

export class SlackChannelFetcher implements Fetcher {
  readonly kind = "slack_channel" as const;

  async fetch(source: SourceConfig, ctx: FetchContext): Promise<FetchResult> {
    const env = ctx.env ?? process.env;
    const channel = source.channel_id;
    if (!channel) return { source: source.id, items: [], warnings: [], error: "no channel_id configured for this Slack source", bytes: 0 };

    const call = ctx.slackApi ?? makeSlackCaller(env.SLACK_BOT_TOKEN);
    if (!call) return { source: source.id, items: [], warnings: [], error: "SLACK_BOT_TOKEN is not set, so the channel cannot be read", bytes: 0 };

    const now = ctx.clock.now();
    const oldest = (now.getTime() - ctx.config.content_window_days * 86_400_000) / 1000;

    let res: Record<string, unknown>;
    try {
      res = await call("conversations.history", { channel, oldest: String(oldest), limit: "200" });
    } catch (e) {
      return { source: source.id, items: [], warnings: [], error: `could not read the Slack channel: ${(e as Error).message}`, bytes: 0 };
    }
    if (res.ok !== true) {
      const err = String(res.error ?? "unknown error");
      const hint = err === "missing_scope" ? " (add channels:history and channels:read to the bot, then reinstall the app)"
        : err === "not_in_channel" ? " (invite the bot to the channel with /invite)"
        : err === "channel_not_found" ? " (check channel_id in config, and that the bot can see the channel)" : "";
      return { source: source.id, items: [], warnings: [], error: `Slack refused the request: ${err}${hint}`, bytes: 0 };
    }

    const messages = Array.isArray(res.messages) ? (res.messages as Array<Record<string, unknown>>) : [];
    const bytes = JSON.stringify(res).length;
    const warnings: string[] = [];
    const items: Item[] = [];
    const names = new Map<string, string>();
    let noLink = 0;

    for (const m of messages) {
      if (m.subtype !== undefined && m.subtype !== "file_share") continue; // joins, topic changes, bot noise
      const text = decodeEntities(String(m.text ?? ""));
      const ts = String(m.ts ?? "");
      const links = [...text.matchAll(SLACK_LINK)].map((x) => x[1] as string).filter(isAbsoluteHttpUrl);
      if (links.length === 0) {
        noLink++;
        continue;
      }

      const userId = String(m.user ?? "");
      if (userId && !names.has(userId)) names.set(userId, await lookupName(call, userId));
      const who = names.get(userId) ?? "A member";

      // The note is whatever the submitter wrote, with the raw link markup removed.
      const note = collapseWhitespace(text.replace(SLACK_LINK, (_all, url: string, label?: string) => label ?? "").trim());
      const link = links[0] as string;
      const summary = note ? firstSentences(note, 2, 280) : "";

      const item: Item = {
        id: itemId(source.id, link),
        source: source.id,
        type: source.type,
        date: new Date(Number(ts.split(".")[0]) * 1000).toISOString(),
        title: note ? firstSentences(note, 1, 100) : `${who} shared a link`,
        summary,
        needs_summary: summary === "",
        link,
        source_ref: `slack:${channel}:${ts}`,
        confidence: "high",
        requires_review: false,
        // Attribution matters here: the verifier must be able to trace the submitter's name.
        raw_excerpt: collapseWhitespace(`${who} shared: ${note || link}`),
      };
      if (links.length > 1) item.related = links.slice(1).map((l) => ({ source: source.id, link: l, title: `Also shared by ${who}` }));
      items.push(item);
    }

    items.sort((a, b) => b.date.localeCompare(a.date));
    if (noLink) warnings.push(`${noLink} message(s) had no link and were skipped`);
    if (res.has_more === true) warnings.push("the channel had more messages than one page; only the most recent 200 were read");
    return { source: source.id, items, warnings, bytes };
  }
}

type SlackCall = (method: string, params: Record<string, string>) => Promise<Record<string, unknown>>;

function makeSlackCaller(token: string | undefined): SlackCall | undefined {
  if (!token) return undefined;
  return async (method, params) => {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
      body: new URLSearchParams(params).toString(),
    });
    return (await res.json()) as Record<string, unknown>;
  };
}

/** Display name for attribution. A failure here is not worth failing the fetch over. */
async function lookupName(call: SlackCall, userId: string): Promise<string> {
  try {
    const r = await call("users.info", { user: userId });
    if (r.ok !== true) return "A member";
    const u = r.user as { real_name?: string; name?: string; profile?: { display_name?: string } } | undefined;
    return u?.profile?.display_name || u?.real_name || u?.name || "A member";
  } catch {
    return "A member";
  }
}
