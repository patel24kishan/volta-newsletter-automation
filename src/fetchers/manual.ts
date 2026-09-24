/**
 * Manual events fetcher. Reads what the curator entered by hand from storage rather than a feed,
 * and emits it every run, because the weekly cycle rebuilds its candidates from freshly fetched
 * items each time. Same windows as the calendar: what is coming up, plus (monthly) what was held in
 * the look back, so an older event drops off on its own.
 */
import type { SourceConfig } from "../config.js";
import { itemFromManualEvent } from "../manual-events.js";
import { isAbsoluteHttpUrl, type Item } from "../schema.js";
import { windowsOf } from "../schedule/period.js";
import type { FetchContext, FetchResult, Fetcher } from "./types.js";

export class ManualEventsFetcher implements Fetcher {
  readonly kind = "manual" as const;

  async fetch(source: SourceConfig, ctx: FetchContext): Promise<FetchResult> {
    const storage = ctx.storage;
    if (!storage) return { source: source.id, items: [], warnings: [], error: "no storage available to read manually added events", bytes: 0 };
    const fallback = source.fallback_link ?? "";
    if (!isAbsoluteHttpUrl(fallback)) {
      return { source: source.id, items: [], warnings: [], error: "fallback_link must be an http(s) page, since a manually added event may have no link of its own", bytes: 0 };
    }

    const { upcoming, past } = windowsOf(ctx);
    let events;
    try {
      // No upper bound, unlike every other source. An event the curator typed is a decision, not a
      // listing that happened to fall in range: one dated past the end of this period used to be
      // read once (it is a candidate the moment it is added), printed in the draft he built, and
      // then dropped by this query on the next refresh, with nothing said. He had added it so that
      // it would go out. The look back still applies, so an event that has been and gone ages off
      // on its own; only the future is open-ended.
      events = storage.listManualEvents((past?.from ?? upcoming.from).toISOString());
    } catch (e) {
      return { source: source.id, items: [], warnings: [], error: `could not read manually added events: ${(e as Error).message}`, bytes: 0 };
    }

    const warnings: string[] = [];
    const items: Item[] = events.map((e) => {
      if (!e.link) warnings.push(`manually added event has no link of its own, linked to ${fallback}: "${e.title}"`);
      const item = itemFromManualEvent(e, source, fallback);
      item.event_timing = Date.parse(e.starts_at) < upcoming.from.getTime() ? "past" : "upcoming";
      return item;
    });
    return { source: source.id, items, warnings, bytes: JSON.stringify(events).length };
  }
}
