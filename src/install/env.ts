/**
 * Every environment variable the installed server reads, in one place. The README's host
 * snippets, .env.example and the extension manifest are checked against this list, so a variable
 * cannot be documented under one name and read under another.
 */
export interface EnvVar {
  name: string;
  /** Set by the person installing it (true), or only by a maintainer or a demo (false). */
  curator: boolean;
  /** Stored by the host as a secret where it can be. */
  secret: boolean;
  what: string;
}

export const ENV_VARS: readonly EnvVar[] = [
  { name: "MAILCHIMP_API_KEY", curator: true, secret: true, what: "Mailchimp API key; its suffix (-us21) names the data centre." },
  { name: "MAILCHIMP_LIST_ID", curator: true, secret: false, what: "The Mailchimp audience the newsletter goes to." },
  { name: "MAILCHIMP_REPLY_TO", curator: true, secret: false, what: "The verified reply-to address on the Mailchimp account." },
  { name: "MAILCHIMP_FROM_NAME", curator: true, secret: false, what: "The sender name on the email; the organisation's name when empty." },
  { name: "SLACK_BOT_TOKEN", curator: true, secret: true, what: "Only if a Slack channel is a source: a bot token (xoxb-) with channels:history, channels:read and users:read." },
  { name: "ALLOW_LIVE", curator: true, secret: false, what: "1 to create and send real campaigns. Anything else is a dry run." },
  { name: "VOLTA_NEWSLETTER_HOME", curator: true, secret: false, what: "Where the database, drafts and log live. Defaults to the OS's per-user data folder." },
  { name: "CONFIG_PATH", curator: false, secret: false, what: "Your own sources, timezone and holidays file; the packaged config when empty." },
  { name: "DATABASE_PATH", curator: false, secret: false, what: "The SQLite file; inside the data folder when empty." },
  { name: "OUT_DIR", curator: false, secret: false, what: "Built drafts and the alerts log; the data folder when empty." },
  { name: "DEMO_NOW", curator: false, secret: false, what: "Run as if it were this moment (ISO 8601). Dry run only." },
  { name: "ALLOW_LIVE_WITH_DEMO_CLOCK", curator: false, secret: false, what: "1 to allow a live run with DEMO_NOW set, for a deliberate live demo." },
];

export const ENV_NAMES: readonly string[] = ENV_VARS.map((v) => v.name);
export const CURATOR_ENV_NAMES: readonly string[] = ENV_VARS.filter((v) => v.curator).map((v) => v.name);
