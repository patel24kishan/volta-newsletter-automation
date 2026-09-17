import type { SourceConfig } from "../config.js";
import { IcsFetcher } from "./ics.js";
import { LinkedInCompanyFetcher } from "./linkedin.js";
import { RssFetcher } from "./rss.js";
import { SlackChannelFetcher } from "./slack-channel.js";
import type { Fetcher } from "./types.js";

const registry: Partial<Record<SourceConfig["kind"], Fetcher>> = {
  rss: new RssFetcher(),
  // A Google News search is just an RSS feed; only the URL is built differently (see config).
  google_news: new RssFetcher(),
  ics: new IcsFetcher(),
  linkedin_company: new LinkedInCompanyFetcher(),
  slack_channel: new SlackChannelFetcher(),
};

/** Returns undefined for source kinds whose fetcher is not built yet. */
export function fetcherFor(kind: SourceConfig["kind"]): Fetcher | undefined {
  return registry[kind];
}
