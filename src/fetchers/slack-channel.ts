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
import { condense } from "../pipeline/condense.js";
import { collapseWhitespace, decodeEntities, firstSentences, splitSentences } from "../text.js";
import { windowsOf } from "../schedule/period.js";
import type { FetchContext, FetchResult, Fetcher } from "./types.js";

/** Messages per page of conversations.history, and the most pages read in one run (1,000 messages). */
const PAGE_SIZE = 200;
const MAX_PAGES = 5;

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

    const { content } = windowsOf(ctx);
    const window = { oldest: String(content.from.getTime() / 1000), latest: String(content.to.getTime() / 1000) };

    // A month of a busy channel runs past one page, so pages are followed up to a cap; the cap
    // keeps one noisy month from turning a weekly run into hundreds of API calls.
    const messages: Array<Record<string, unknown>> = [];
    let bytes = 0;
    let cursor = "";
    let res: Record<string, unknown> = {};
    for (let page = 0; page < MAX_PAGES; page++) {
      try {
        res = await call("conversations.history", { channel, ...window, limit: String(PAGE_SIZE), ...(cursor ? { cursor } : {}) });
      } catch (e) {
        return { source: source.id, items: [], warnings: [], error: `could not read the Slack channel: ${(e as Error).message}`, bytes: 0 };
      }
      if (res.ok !== true) break;
      bytes += JSON.stringify(res).length;
      if (Array.isArray(res.messages)) messages.push(...(res.messages as Array<Record<string, unknown>>));
      cursor = String((res.response_metadata as { next_cursor?: string } | undefined)?.next_cursor ?? "");
      if (res.has_more !== true || !cursor) break;
    }
    if (res.ok !== true) {
      const err = String(res.error ?? "unknown error");
      const hint = err === "missing_scope" ? " (add channels:history and channels:read to the bot, then reinstall the app)"
        : err === "not_in_channel" ? " (invite the bot to the channel with /invite)"
        : err === "channel_not_found" ? " (check channel_id in config, and that the bot can see the channel)" : "";
      return { source: source.id, items: [], warnings: [], error: `Slack refused the request: ${err}${hint}`, bytes: 0 };
    }

    const warnings: string[] = [];
    const items: Item[] = [];
    const names = new Map<string, string>();
    let noLink = 0;
    let noMessageLink = 0;

    for (const m of messages) {
      if (m.subtype !== undefined && m.subtype !== "file_share") continue; // joins, topic changes, bot noise
      const text = decodeEntities(String(m.text ?? ""));
      const ts = String(m.ts ?? "");

      // Structured founder-update write-ups carry no external link: the Slack message is the source.
      const update = parseFounderUpdate(text);
      if (update) {
        const permalink = await permalinkFor(call, channel, ts);
        if (!permalink) {
          // Never invent a link (constraint 5). Without a real permalink the item is not emitted.
          warnings.push(`could not get a permalink for the ${update.company} update, so it was skipped`);
          continue;
        }
        items.push(founderUpdateItem(update, source, channel, ts, permalink));
        continue;
      }

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
      // Condensed like every other entry from this channel, so a long pasted message stays short.
      const summary = note ? cap(condense([note]).join(" "), 280) : "";

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
      // A way back to the message itself, for Bader. Only Slack's own permalink, never a guessed one.
      const messageLink = await permalinkFor(call, channel, ts);
      if (messageLink) item.message_link = messageLink;
      else noMessageLink++;
      if (links.length > 1) item.related = links.slice(1).map((l) => ({ source: source.id, link: l, title: `Also shared by ${who}` }));
      items.push(item);
    }

    items.sort((a, b) => b.date.localeCompare(a.date));
    if (noMessageLink) warnings.push(`${noMessageLink} message link(s) could not be fetched, so those items show only the shared link`);
    if (noLink) warnings.push(`${noLink} message(s) had no link and were skipped`);
    if (res.has_more === true) warnings.push(`the channel had more messages in the window than could be read; only the most recent ${messages.length} were read`);
    return { source: source.id, items, warnings, bytes };
  }
}

/**
 * A founder-update write-up as posted to the channel:
 *
 *   [:hourglass_flowing_sand: *HOLD — REVISIT w/c Sep 28 (embargo)*]     optional
 *   :studio_microphone: *Company · Person, role · Thu, Sep 17, 2026*
 *
 *   One-line topic. 23 min, recorded.
 *   *Conversation* ...
 *   *Summary*
 *   • bullet
 *   • *Newsletter angle:* ...
 */
export interface FounderUpdate {
  company: string;
  /** "Yuki Tanaka, co-founder" */
  person: string;
  /** "Thu, Sep 17, 2026", kept as written for the excerpt. */
  dateText: string;
  topic: string;
  /** Set when the post is on hold; the text after "HOLD —", e.g. "REVISIT w/c Sep 28 (embargo)". */
  hold?: string;
  /** Every bullet under *Summary*, markup removed. */
  bullets: string[];
  /** The "Newsletter angle" bullet, without its label. */
  angle?: string;
  /**
   * What a reader can be told: the bullets before the "Newsletter angle" one, with any sentence
   * that speaks to the editor removed.
   */
  insights: string[];
  /**
   * What the write-up says to the editor, kept so it is never lost: the newsletter angle, the
   * bullets after it, editor-directed sentences taken out of the insights, and for a held post
   * the "Why it's held" and "Revisit" lines.
   */
  notes: string[];
}

const HEADER = /:studio_microphone:\s*\*(.+?)\s+·\s+(.+?)\s+·\s+([A-Za-z]{3},\s+[A-Za-z]{3}\s+\d{1,2},\s+\d{4})\s*\*/;
const HOLD = /:hourglass_flowing_sand:\s*\*HOLD\s*[—–-]\s*(.+?)\s*\*/;

export function parseFounderUpdate(text: string): FounderUpdate | undefined {
  const head = HEADER.exec(text);
  if (!head) return undefined;
  const afterHeader = text.slice(head.index + head[0].length);
  const topicLine = afterHeader.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";

  const bullets: string[] = [];
  const afterBullets: string[] = [];
  const summaryAt = text.indexOf("*Summary*");
  if (summaryAt >= 0) {
    let inBullets = true;
    for (const raw of text.slice(summaryAt + "*Summary*".length).split("\n")) {
      const line = raw.trim();
      if (line === "") continue;
      if (inBullets && line.startsWith("•")) bullets.push(line.replace(/^•\s*/, ""));
      else {
        inBullets = false; // the next section heading ends the bullet list
        afterBullets.push(line);
      }
    }
  }

  const angleAt = bullets.findIndex((b) => /^\*?Newsletter angle:\*?/i.test(b));
  const angleBullet = angleAt >= 0 ? bullets[angleAt] : undefined;
  const factual = (angleAt >= 0 ? bullets.slice(0, angleAt) : bullets).map(plain);
  const trailing = (angleAt >= 0 ? bullets.slice(angleAt) : []).map(plain);

  const insights: string[] = [];
  const pulled: string[] = [];
  for (const b of factual) {
    const { keep, editorial } = splitEditorial(b);
    if (keep) insights.push(keep);
    pulled.push(...editorial);
  }
  // "*Why it's held*" then its text: fold each heading into the line that follows it.
  const sections: string[] = [];
  let heading = "";
  for (const line of afterBullets) {
    const h = /^\*([^*]+)\*$/.exec(line);
    if (h) { heading = plain(h[1] ?? ""); continue; }
    const body = plain(line.replace(/^→\s*/, ""));
    if (body) sections.push(heading ? `${heading}: ${body}` : body);
  }

  const update: FounderUpdate = {
    company: plain(head[1] ?? ""),
    person: plain(head[2] ?? ""),
    dateText: head[3] ?? "",
    topic: firstSentences(plain(topicLine), 1, 140),
    bullets: bullets.map(plain),
    insights,
    notes: [...trailing, ...pulled, ...sections].filter(Boolean),
  };
  const hold = HOLD.exec(text);
  if (hold) update.hold = plain(hold[1] ?? "");
  if (angleBullet) update.angle = plain(angleBullet.replace(/^\*?Newsletter angle:\*?\s*/i, ""));
  return update;
}

/** Sentences that open by telling the editor what to do, or by judging the material. */
const EDITOR_OPENERS = /^(chase|check|confirm(ed (she|he|they))?|ask|publish|run|avoid|diarise|diarize|flag|include|lead with|worth asking|easy follow-up|that's the (story|close|substance)|rare case|better story|fails the bar|no relationship risk|clean, defensible|strong interactive)\b/i;
/** Phrases that only make sense said to the editor, wherever they fall in a sentence. */
const EDITOR_PHRASES = /\b(before we run|before quoting|before publishing|don't publish|do not publish|newsletter angle|follow-up piece|go on record|in print|the piece|whatever you write|for readers|explicitly (asked|confirmed)|asked that)\b/i;
/** A label the write-up puts in front of a quote for the editor's benefit. */
const EDITOR_LABEL = /^quotable:\s*/i;

/**
 * Separate what a reader can be told from what was said to the editor, sentence by sentence.
 * This is pattern matching, not understanding: it removes the cautions seen in real write-ups and
 * will miss phrasings it has not seen. Whatever it removes goes to the curator's notes rather than
 * being discarded, and the curator still previews every draft before anything is sent.
 */
export function splitEditorial(bullet: string): { keep: string; editorial: string[] } {
  const keep: string[] = [];
  const editorial: string[] = [];
  // splitSentences only ever cuts, so every sentence ends up in one list or the other.
  for (const s of splitSentences(bullet.replace(EDITOR_LABEL, ""))) (EDITOR_OPENERS.test(s) || EDITOR_PHRASES.test(s) ? editorial : keep).push(s);
  return { keep: keep.join(" "), editorial };
}

/** Slack emphasis markers and the tool's sign-off are presentation, not content. */
function plain(s: string): string {
  return collapseWhitespace(s.replace(/\*Sent using\*\s*Claude\s*$/i, "").replace(/\*([^*\n]+)\*/g, "$1").replace(/(^|\s)_([^_\n]+)_(?=\s|[.,;:!?]|$)/g, "$1$2"));
}

function cap(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…";
}

function founderUpdateItem(u: FounderUpdate, source: SourceConfig, channel: string, ts: string, permalink: string): Item {
  // The title is what a reader would see. "MARKED FOR REVIEW" is the curator's label, added by the
  // Slack list from requires_review, so it can never leak into a newsletter.
  const title = u.topic ? `${u.company}: ${u.topic}` : `${u.company} · ${u.person}`;
  // What goes in the newsletter is a condensed entry, not the write-up: at most two single-sentence
  // points chosen from everything a reader may be told. Copying every bullet made eight updates
  // into 640 of a draft's 767 words.
  const points = condense(u.insights);
  // The line shown beside the item while choosing: a held post leads with its points, a clear one
  // with the write-up's own newsletter angle.
  const summary = u.hold
    ? cap(points.join(" "), 320)
    : cap(u.angle ?? points[0] ?? "", 320);
  const item: Item = {
    id: itemId(source.id, permalink),
    source: source.id,
    type: source.type,
    // When it was posted. The header's own date has no time of day, and posts land the same day.
    date: new Date(Number(ts.split(".")[0]) * 1000).toISOString(),
    title,
    summary,
    needs_summary: summary === "",
    link: permalink,
    source_ref: `slack:${channel}:${ts}`,
    confidence: "high",
    requires_review: u.hold !== undefined,
    raw_excerpt: collapseWhitespace([
      `${u.company} · ${u.person} · ${u.dateText}.`,
      u.hold ? `HOLD — ${u.hold}.` : "",
      u.topic,
      ...u.bullets,
    ].filter(Boolean).join(" ")),
    byline: u.person,
  };
  if (points.length) item.insights = points;
  if (u.notes.length) item.editor_notes = u.notes.slice(0, 8).map((s) => cap(s, 400));
  if (u.hold) item.hold_note = u.hold;
  return item;
}

/** Slack's own permalink for a message. Undefined on any failure; the caller must not guess one. */
async function permalinkFor(call: SlackCall, channel: string, ts: string): Promise<string | undefined> {
  try {
    const r = await call("chat.getPermalink", { channel, message_ts: ts });
    const link = r.ok === true ? String(r.permalink ?? "") : "";
    return isAbsoluteHttpUrl(link) ? link : undefined;
  } catch {
    return undefined;
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
