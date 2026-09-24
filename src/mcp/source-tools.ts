/**
 * Turning what Bader says about a source into a stored source, and back into words he can read.
 *
 * The tools themselves are registered in newsletter-server.ts; everything here is pure, so what he
 * is told when a channel link is wrong, or a token is missing, is tested without a server or a
 * network. Nothing here accepts newsletter text: a source is an address, an id, search words and
 * filter words, and the name he gives it is only ever shown back to him in the source list.
 */
import type { Config, SourceConfig, SourceKind } from "../config.js";
import { curatorSourceId } from "../sources/curator-sources.js";
import type { CuratorSource, NewCuratorSource } from "../storage.js";

/** The kinds Bader can add. `manual` is not one: add_event owns the one manual source. */
export const ADDABLE_KINDS = ["rss", "google_news", "ics", "linkedin_company", "slack_channel"] as const;
export type AddableKind = (typeof ADDABLE_KINDS)[number];

/** What each kind reads, in Bader's words, for the list and for what a tool says back. */
export const KIND_LABEL: Record<AddableKind, string> = {
  rss: "a feed",
  google_news: "a news search",
  ics: "a calendar",
  linkedin_company: "a LinkedIn page",
  slack_channel: "a Slack channel",
};

/** What kind of item a source produces. Bader never types this; it follows from the kind. */
function itemTypeFor(kind: AddableKind, content?: "news" | "events"): string {
  if (kind === "ics") return "event";
  if (kind === "linkedin_company") return "linkedin";
  if (kind === "slack_channel") return "member_social";
  return content === "events" ? "event" : "news";
}

export interface AddSourceFields {
  kind: AddableKind;
  url?: string;
  terms?: string[];
  channel_id?: string;
  keywords?: string[];
  name?: string;
  content?: "news" | "events";
}

/**
 * A Slack channel id from whatever he pasted: the id itself, or a channel link, which is what
 * "Copy link" in Slack gives. A #name cannot be resolved without a scope the bot does not have,
 * so it is refused with words that tell him what to paste instead.
 */
export function slackChannelId(given: string): { id: string } | { error: string } {
  const raw = given.trim();
  if (/^[A-Z0-9]{6,}$/.test(raw)) return { id: raw };
  const fromLink = /\/archives\/([A-Z0-9]{6,})/.exec(raw);
  if (fromLink) return { id: fromLink[1]! };
  if (raw.startsWith("#")) {
    return { error: `I cannot look a channel up by name. In Slack, right-click ${raw} and choose Copy link, then give me that link.` };
  }
  return { error: "That is not a Slack channel id or link. In Slack, right-click the channel and choose Copy link (it looks like https://volta.slack.com/archives/C0123ABCD), then give me that." };
}

/** What Bader gave, as a row ready to store, or the reasons it cannot be one. */
export function sourceFromFields(f: AddSourceFields, takenIds: Iterable<string>): { row: NewCuratorSource } | { errors: string[] } {
  const errors: string[] = [];
  const url = f.url?.trim() ?? "";
  let channelId = "";

  if (f.kind === "google_news") {
    if (!f.terms?.length) errors.push("A news search needs the words to search for, such as Volta Halifax.");
  } else if (f.kind === "slack_channel") {
    const given = f.channel_id?.trim() || url;
    if (!given) errors.push("A Slack channel needs its link. In Slack, right-click the channel and choose Copy link.");
    else {
      const found = slackChannelId(given);
      if ("error" in found) errors.push(found.error);
      else channelId = found.id;
    }
  } else if (!/^https?:\/\//.test(url)) {
    errors.push(`${KIND_LABEL[f.kind]} needs its full address, starting with https://.`);
  }
  if (errors.length) return { errors };

  const label = f.name?.trim() ?? "";
  const row: NewCuratorSource = {
    id: curatorSourceId({ ...(label ? { label } : {}), ...(url ? { url } : {}), ...(f.terms ? { terms: f.terms } : {}), ...(channelId ? { channel_id: channelId } : {}) }, takenIds),
    kind: f.kind,
    type: itemTypeFor(f.kind, f.content),
    url: f.kind === "google_news" || f.kind === "slack_channel" ? "" : url,
    terms: f.terms ?? [],
    channel_id: channelId,
    fallback_link: f.kind === "ics" && url ? url : "",
    keywords: f.keywords ?? [],
    // Absent keywords mean the newsletter's watchlist, as for every source the maintainer set up.
    filtered: f.keywords !== undefined,
    label,
    enabled: true,
  };
  return { row };
}

/** What a source reads, in one phrase: its address, its search words or its channel. */
export function readsWhat(row: Pick<CuratorSource, "kind" | "url" | "terms" | "channel_id">): string {
  if (row.kind === "google_news") return `a news search for ${row.terms.join(" or ")}`;
  if (row.kind === "slack_channel") return `the Slack channel ${row.channel_id}`;
  return row.url;
}

/**
 * How a source filters, in Bader's words. The watchlist is applied to news feeds and searches
 * only: a calendar, a LinkedIn page or a Slack channel has never been filtered, so saying "keeps
 * the watchlist" about one would invent a filter that does not exist.
 */
export function filterWords(row: Pick<CuratorSource, "keywords" | "filtered">, config: Pick<Config, "watchlist">, kind?: string): string {
  if (row.filtered) {
    const words = row.keywords.map((k) => k.trim()).filter(Boolean);
    return words.length ? `only items mentioning ${words.join(" or ")}` : "everything it publishes";
  }
  return watchlistApplies(kind)
    ? `the newsletter's watchlist (${config.watchlist.join(", ")})`
    : "everything it publishes";
}

/** True for the kinds the watchlist is applied to while reading (src/fetchers/rss.ts). */
export function watchlistApplies(kind?: string): boolean {
  return kind === "rss" || kind === "google_news" || kind === undefined;
}

/**
 * Just the words a source filters on, for sentences that need them inline ("none of them mention
 * ocean or fisheries"). filterWords returns a whole clause, which cannot be spliced mid-sentence.
 */
export function filterTerms(row: Pick<CuratorSource, "keywords" | "filtered">, config: Pick<Config, "watchlist">, kind?: string): string {
  const words = row.filtered ? row.keywords.map((k) => k.trim()).filter(Boolean) : watchlistApplies(kind) ? config.watchlist : [];
  return words.join(" or ");
}

/** What a maintainer's source keeps, for the same sentence. */
export function configKeeps(kind: string, config: Pick<Config, "watchlist">): string {
  return watchlistApplies(kind) ? `the newsletter's watchlist (${config.watchlist.join(", ")})` : "everything it publishes";
}

/** Whether a source needs something set up before it can be read, and what to do about it. */
export function credentialNote(kind: string, env: NodeJS.ProcessEnv): string | undefined {
  if (kind === "slack_channel" && !env.SLACK_BOT_TOKEN) {
    return "It cannot be read yet: SLACK_BOT_TOKEN is not set on this computer, which only the maintainer can do. Once it is, say: turn this source back on.";
  }
  if (kind === "slack_channel") {
    return "Make sure the bot is in that channel: in Slack, type /invite @Volta Newsletter there.";
  }
  if (kind === "linkedin_company") {
    return "LinkedIn is read as a guest, once per run. It sometimes serves a sign-in page instead, and then nothing can be read that month.";
  }
  return undefined;
}

/** A source in the list Bader is shown: the maintainer's or his, with how it did last time. */
export function sourceLine(o: {
  source: Pick<SourceConfig, "id" | "kind" | "enabled">;
  mine?: CuratorSource;
  config: Pick<Config, "watchlist">;
  lastRun?: string;
  /** Where he goes to deal with it: the feed, the page, or the Slack channel itself. */
  link?: string;
}): string {
  const kind = o.source.kind as AddableKind;
  const name = o.mine?.label || o.source.id;
  const reads = o.mine ? readsWhat(o.mine) : describeConfigSource(o.source as SourceConfig);
  const bits = [
    `${o.source.enabled ? "on" : "off"}`,
    o.mine ? `added by you on ${o.mine.added_at.slice(0, 10)}` : "set up by the maintainer",
    o.mine ? `keeps ${filterWords(o.mine, o.config, o.source.kind)}` : `keeps ${configKeeps(o.source.kind, o.config)}`,
    o.lastRun ? `last run: ${o.lastRun}` : "",
  ].filter(Boolean);
  // The link is given even when it repeats the address: for a Slack channel it opens the channel,
  // which he would otherwise have to go and find himself.
  return [
    `- ${name} (${KIND_LABEL[kind] ?? o.source.kind}): ${reads}`,
    `  ${bits.join(" · ")}`,
    ...(o.link ? [`  open: ${o.link}`] : []),
    `  id: ${o.source.id}`,
  ].join("\n");
}

function describeConfigSource(s: SourceConfig): string {
  if (s.kind === "google_news") return `a news search for ${(s.terms ?? []).join(" or ")}`;
  if (s.kind === "slack_channel") return `the Slack channel ${s.channel_id ?? ""}`;
  if (s.kind === "manual") return "events Bader adds himself";
  return s.url;
}

/** True for a kind Bader is allowed to add. */
export function isAddableKind(kind: string): kind is AddableKind {
  return (ADDABLE_KINDS as readonly string[]).includes(kind);
}

/** The kinds as a SourceKind, for the fetcher registry. */
export function asSourceKind(kind: AddableKind): SourceKind {
  return kind;
}
