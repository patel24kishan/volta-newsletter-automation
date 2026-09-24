/**
 * What a source that did not work means, and what to do about it.
 *
 * A run records a source's fate as "id: status (error)", which is right for a log and useless to
 * Bader: "member-updates: failed (Slack refused the request: not_in_channel)" tells him nothing he
 * can act on. Every place that shows him a source's fate — the monthly reminder, the month's
 * preparation, the source list — goes through here instead, so he reads the same sentence
 * everywhere: what happened, whose job the fix is, where to go, and what to say afterwards.
 *
 * Constraint 8 (CLAUDE.md) is "fail loudly". Loud is not enough if nobody knows what to do.
 */
import type { SourceConfig } from "../config.js";

/** A source's fate as the run recorded it. */
export interface SourceNote {
  id: string;
  status: "ok" | "empty" | "failed" | "skipped";
  error?: string;
  warnings?: string[];
}

/**
 * A source's fate as one line, kept in the saved review: "news-volta: empty [51 item(s) outside
 * the window]". The warnings ride along in brackets because they are what tells a quiet month from
 * a month whose items were all thrown away, and the review only has room for strings.
 */
export function formatSourceNote(note: SourceNote): string {
  const warnings = (note.warnings ?? []).filter(Boolean);
  return `${note.id}: ${note.status}${note.error ? ` (${note.error})` : ""}${warnings.length ? ` [${warnings.join(" | ")}]` : ""}`;
}

/** The same line back into its parts. */
export function parseSourceNote(note: string): SourceNote {
  const m = /^([^:]+): (empty|failed|skipped|ok)(?: \((.*?)\))?(?: \[(.*)\])?$/.exec(note);
  if (!m) return { id: note, status: "failed" };
  const [, id, status, detail, warnings] = m;
  return {
    id: id!,
    status: status as SourceNote["status"],
    ...(detail ? { error: detail } : {}),
    ...(warnings ? { warnings: warnings.split(" | ") } : {}),
  };
}

/**
 * Where Bader goes to deal with a source: its feed, its page, or the Slack channel itself.
 * The Slack address is Slack's own redirect, which opens the channel in his app without anyone
 * having to build a message link by hand (constraint 5).
 */
export function sourceLink(source: Pick<SourceConfig, "kind" | "url" | "channel_id" | "fallback_link">): string | undefined {
  if (source.kind === "slack_channel") return source.channel_id ? `https://slack.com/app_redirect?channel=${source.channel_id}` : undefined;
  if (source.kind === "manual") return source.fallback_link;
  return source.url || source.fallback_link;
}

/** What to do about a failure, in Bader's words. Undefined when there is nothing he can do. */
export function remedyFor(note: SourceNote, o: { kind?: string; name?: string; keeps?: string; keepsWords?: string; env?: NodeJS.ProcessEnv; periodWord?: string } = {}): string | undefined {
  const err = note.error ?? "";
  const say = `then say: refresh${o.periodWord ? ` this ${o.periodWord}` : ""}.`;

  if (/SLACK_BOT_TOKEN is not set/.test(err)) {
    return `The maintainer has to set SLACK_BOT_TOKEN on this computer. Once they have, ${say}`;
  }
  if (/not_in_channel/.test(err)) {
    return `The bot is not in that channel. Open it, type /invite @Volta Newsletter, ${say}`;
  }
  if (/missing_scope/.test(err)) {
    return "The maintainer has to give the bot permission to read channels (channels:history, channels:read and users:read) and reinstall it.";
  }
  if (/channel_not_found/.test(err)) {
    return "That channel cannot be seen: check the link, and that it is not a private channel the bot was never invited to.";
  }
  if (/login wall|sign-?in/i.test(err)) {
    return "Nothing to do: LinkedIn showed a sign-in page instead of the public one. It usually works next time.";
  }
  if (/not an RSS( 2\.0)? (or Atom )?feed|no <rss><channel>|not an iCalendar feed|no BEGIN:VCALENDAR|not parseable as XML|could not be parsed/i.test(err)) {
    const kindWord = /iCalendar|VCALENDAR/i.test(err) || o.kind === "ics" ? "a calendar file" : "a feed";
    return `That address is a web page, not ${kindWord}. Look for the feed or calendar link on that site, ${say}`;
  }
  if (/empty response body/i.test(err)) {
    return `The address answered with nothing at all. Check the link, ${say}`;
  }
  if (/no channel_id configured/i.test(err)) {
    return "That Slack source has no channel: remove it and add it again with the channel's link.";
  }
  if (/Slack refused the request/i.test(err)) {
    return "Slack refused it for a reason this cannot explain. Tell the maintainer, with that word from the message.";
  }
  if (/no storage available|fallback_link must be/i.test(err)) {
    return "That is a fault in how the newsletter is set up, not something you can fix: tell the maintainer.";
  }
  if (/HTTP 4\d\d/.test(err)) {
    return `The address was refused, so it may have moved or been taken down. Check the link, ${say}`;
  }
  if (/ENOTFOUND|getaddrinfo|ERR_NAME_NOT_RESOLVED/i.test(err)) {
    return `Nothing answers at that address, so it is probably a typo. Check it against the site, ${say}`;
  }
  // Reaches Bader now that the reason survives the fetch (src/http.ts). Waiting will not fix it,
  // which is what the outage line below would have told him.
  if (/CERT_|ERR_TLS|certificate|SELF_SIGNED/i.test(err)) {
    return "That site's security certificate is not valid, so it cannot be read safely. Only the site's owner can fix it: leave the source off, or remove it if it stays broken.";
  }
  if (/HTTP 5\d\d|fetch failed|timed out|ECONNREFUSED/i.test(err)) {
    return `The site did not answer. That is usually temporary, but check the address for a typo if it keeps failing. ${say[0]!.toUpperCase()}${say.slice(1)}`;
  }
  if (/the reader for this source broke/.test(err)) {
    return "This is a fault in the newsletter itself, not something you can fix: tell the maintainer.";
  }
  if (note.status === "skipped") {
    return "Nothing reads that kind of source yet: tell the maintainer, or remove the source.";
  }
  if (note.status === "empty") {
    // Everything it published was thrown away by the filter. Saying "quiet month" here is a lie,
    // and it is the likeliest thing to happen the first time Bader adds a feed of his own.
    // Everything it published was outside the span this period reads. Telling him to change his
    // search words would send him after the wrong thing entirely.
    const outside = countIn(note.warnings ?? [], /^(\d+) (?:item|post|event)\(s\) outside the window(?: \((.*)\))?/);
    if (outside.count) {
      return `It published ${outside.count} item(s), but they were all outside the dates this ${o.periodWord ?? "period"} reads${outside.detail ? ` (${outside.detail})` : ""}. Nothing to do unless you expected something newer.`;
    }
    const dropped = droppedCount(note.warnings ?? []);
    if (dropped) {
      const name = o.name || note.id;
      const words = o.keepsWords ? ` ${o.keepsWords}` : " any of the words it filters on";
      return `It published ${dropped} item(s), but none of them mention${words}. To keep everything it publishes, say: keep everything from ${name}.`;
    }
    return o.kind === "google_news"
      ? "That can be normal for a quiet month. If it keeps happening, the search words may be too narrow."
      : "That can be normal for a quiet month.";
  }
  return undefined;
}

/** The first warning matching a counting pattern, as a number and whatever detail it carried. */
function countIn(warnings: string[], pattern: RegExp): { count: number; detail?: string } {
  for (const w of warnings) {
    const m = pattern.exec(w);
    if (m) return { count: Number(m[1]), ...(m[2] ? { detail: m[2] } : {}) };
  }
  return { count: 0 };
}

/** How many items a source published and then dropped as off-topic, from its own warnings. */
export function droppedCount(warnings: string[]): number {
  return countIn(warnings, /^(\d+) item\(s\) dropped as off-topic/).count;
}

/** A source's fate as one or two sentences for Bader, with where to go and what to do. */
export function explainSourceNote(
  note: SourceNote,
  o: { name?: string; kind?: string; keeps?: string; keepsWords?: string; link?: string; env?: NodeJS.ProcessEnv; periodWord?: string } = {},
): string {
  const name = o.name || note.id;
  const remedy = remedyFor(note, o);
  // The raw error is a developer's sentence ("GET ... failed: fetch failed", "channel_not_found
  // (check channel_id in config)"). It is only shown when nothing better can be said.
  const detail = remedy || !note.error ? "" : `: ${note.error}`;
  const what = note.status === "empty" ? `${name} found nothing this time.`
    : note.status === "skipped" ? `${name} was not read${detail}.`
    : `${name} could not be read${detail}.`;
  return [what, remedy, o.link ? `(${o.link})` : undefined].filter(Boolean).join(" ");
}

/**
 * A source that answered but whose items came back unusable: the reason its warnings matter.
 * The run marks such a source "ok", so without this its warning is never shown and Bader sends a
 * newsletter with empty entries in it, which is how ten LinkedIn posts reached a real campaign.
 */
export function worthSaying(warning: string): boolean {
  // Deliberately not "dropped as off-topic": a source doing its filtering job is not a problem, and
  // when everything it published was dropped the explanation already says so, in numbers.
  //
  // "skipped", not "were skipped": every fetcher writes it differently -- "skipped item without
  // title", "so it was skipped", "were skipped" -- and the narrow pattern matched only the last.
  // A whole founder update could be dropped for a missing permalink while the source still
  // reported "ok" and Bader heard nothing. Every "skipped" warning means an item was lost.
  return /fell back|markup may have changed|no JSON-LD|came with no text|link\(s\) could not be fetched|more messages in the window than could be read|may be missing|skipped|unknown TZID|broke/i.test(warning);
}
