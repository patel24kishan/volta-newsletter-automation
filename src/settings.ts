/**
 * What the curator sets once, in chat, and keeps across updates: the names the newsletter uses
 * and their timezone. Stored as rows in the database (table `settings`), never in a file inside
 * the package, and read on every call so the change applies without a restart.
 *
 * Credentials are not settings. They come from the host's environment and are never asked for
 * in chat.
 */
import { brandOf, DEFAULT_ORG, type Brand } from "./brand.js";
import { isKnownTimeZone } from "./clock.js";
import type { Storage } from "./storage.js";

export const SETTING_KEYS = ["organisation", "newsletter_name", "curator_name", "from_name", "timezone", "set_up_at"] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];
export type Settings = Partial<Record<SettingKey, string>>;

type SettingsStore = Pick<Storage, "listSettings" | "setSetting">;

export function readSettings(storage: Pick<Storage, "listSettings">): Settings {
  const s: Settings = {};
  for (const row of storage.listSettings()) {
    if ((SETTING_KEYS as readonly string[]).includes(row.key)) s[row.key as SettingKey] = row.value;
  }
  return s;
}

export const brandFor = (storage: Pick<Storage, "listSettings">): Brand => brandOf(readSettings(storage));

/** True once the curator has been through the set-up, whatever they chose. */
export const isSetUp = (s: Settings): boolean => Boolean(s.set_up_at);

/** The fields the set-up tool takes. Every one is plain text the curator said. */
export interface SetupFields {
  organisation?: string | undefined;
  curator_name?: string | undefined;
  newsletter_name?: string | undefined;
  from_name?: string | undefined;
  timezone?: string | undefined;
}

const MAX = 80;
const clean = (s: string | undefined): string => (s ?? "").trim();

/** Problems with the fields, in the curator's words. Empty when they can be saved. */
export function validateSetup(f: SetupFields): string[] {
  const errors: string[] = [];
  if (!clean(f.organisation)) errors.push(`Organisation is needed: the name the newsletter is from (for example "${DEFAULT_ORG}").`);
  if (!clean(f.curator_name)) errors.push("Your name is needed, so the reminder can greet you.");
  for (const [label, v] of [["Organisation", f.organisation], ["Your name", f.curator_name], ["Newsletter name", f.newsletter_name], ["Sender name", f.from_name]] as const) {
    const s = clean(v);
    if (s.length > MAX) errors.push(`${label} is too long (${s.length} characters; ${MAX} at most).`);
    if (/[\r\n]/.test(s)) errors.push(`${label} must be one line.`);
  }
  const tz = clean(f.timezone);
  if (tz && !isKnownTimeZone(tz)) errors.push(`"${tz}" is not a timezone this computer knows. Use an IANA name such as America/Halifax or Europe/London.`);
  return errors;
}

/** The settings as they would be after saving `f` over `current`: a field left out keeps its value. */
export function merged(current: Settings, f: SetupFields): Settings {
  const next: Settings = { ...current };
  const put = (k: SettingKey, v: string | undefined) => { if (v !== undefined) next[k] = clean(v); };
  put("organisation", f.organisation);
  put("curator_name", f.curator_name);
  put("newsletter_name", f.newsletter_name);
  put("from_name", f.from_name);
  put("timezone", f.timezone);
  return next;
}

/** What saving would change, line by line, for the curator to confirm. */
export function setupPreview(current: Settings, f: SetupFields, configTimeZone: string): string[] {
  const before = brandOf(current);
  const after = brandOf(merged(current, f));
  const was = (a: string, b: string) => (a === b ? "" : ` (was ${b})`);
  const lines = [
    `Organisation: ${after.org}${was(after.org, before.org)}`,
    `Newsletter: ${after.newsletter}${was(after.newsletter, before.newsletter)}`,
    `Curator: ${after.curator ?? "(not set)"}${before.curator && before.curator !== after.curator ? ` (was ${before.curator})` : ""}`,
    `Sender name on the email: ${after.fromName} (MAILCHIMP_FROM_NAME overrides this when it is set)`,
  ];
  const tz = clean(f.timezone) || current.timezone;
  if (tz) lines.push(`Timezone: ${tz}${tz !== configTimeZone ? ` (was ${configTimeZone}; applies when the host next starts the server)` : ""}`);
  lines.push(`Where these show: the email's subject ("${after.org} this month: …"), its headings, masthead and footer, and the reminder's greeting.`);
  return lines;
}

export function saveSetup(storage: SettingsStore, f: SetupFields, nowIso: string): Settings {
  const next = merged(readSettings(storage), f);
  next.set_up_at = nowIso;
  for (const k of SETTING_KEYS) storage.setSetting(k, next[k] ?? null, nowIso);
  return next;
}

/** The first line of newsletter_status: what it is running as, and how to change it. */
export function settingsStatusLine(s: Settings): string {
  const b = brandOf(s);
  if (!isSetUp(s)) {
    return `Not set up yet: running as "${b.org}" with no curator name. Say "set up the newsletter" to name the organisation, the newsletter and yourself; it applies at once and survives updates.`;
  }
  return `Newsletter: ${b.newsletter} (${b.org}), curator ${b.curator ?? "not named"}${s.timezone ? `, timezone ${s.timezone}` : ""}.`;
}
