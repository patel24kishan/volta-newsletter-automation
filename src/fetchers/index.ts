import type { SourceConfig } from "../config.js";
import { RssFetcher } from "./rss.js";
import type { Fetcher } from "./types.js";

const registry: Partial<Record<SourceConfig["kind"], Fetcher>> = {
  rss: new RssFetcher(),
};

/** Returns undefined for source kinds whose fetcher is not built yet. */
export function fetcherFor(kind: SourceConfig["kind"]): Fetcher | undefined {
  return registry[kind];
}
