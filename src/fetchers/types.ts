import type { Config, SourceConfig } from "../config.js";
import type { Clock } from "../clock.js";
import type { Item } from "../schema.js";

export interface FetchContext {
  config: Config;
  clock: Clock;
  /** Overrides the network for tests: return the raw body for a URL. */
  fetchText?: (url: string) => Promise<string>;
  /** Overrides the Slack Web API for tests. */
  slackApi?: (method: string, params: Record<string, string>) => Promise<Record<string, unknown>>;
  /** Where credentials come from; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

export interface FetchResult {
  source: string;
  items: Item[];
  /** Non-fatal notes: items dropped as off-topic, outside the window, or missing a link. */
  warnings: string[];
  /** Set when the source could not be read or parsed. Items will be empty. */
  error?: string;
  /** Raw body length, for the pre-flight report. */
  bytes: number;
}

export interface Fetcher {
  readonly kind: SourceConfig["kind"];
  fetch(source: SourceConfig, ctx: FetchContext): Promise<FetchResult>;
}
