/**
 * The names the newsletter prints and speaks: the organisation, the newsletter itself, the
 * curator, and the sender name on the email. Volta is the default; an installed copy changes
 * them once through the set-up tool (src/settings.ts) and they are read from the database on
 * every call, so a change applies at once and survives an update.
 */
export interface Brand {
  /** "Volta": the subject, headings, masthead and footer all name it. */
  org: string;
  /** "Volta Newsletter": also the Slack bot's name, for the invite instruction. */
  newsletter: string;
  /** Greeted by name in the reminder; absent until set. */
  curator?: string;
  /** The sender name on the email; MAILCHIMP_FROM_NAME overrides it when set. */
  fromName: string;
}

export const DEFAULT_ORG = "Volta";

export interface BrandFields {
  organisation?: string | undefined;
  newsletter_name?: string | undefined;
  curator_name?: string | undefined;
  from_name?: string | undefined;
}

const clean = (s: string | undefined): string => (s ?? "").trim();

/** The brand from saved fields, with Volta's defaults for anything not set. */
export function brandOf(f: BrandFields = {}): Brand {
  const org = clean(f.organisation) || DEFAULT_ORG;
  const curator = clean(f.curator_name);
  return {
    org,
    newsletter: clean(f.newsletter_name) || `${org} Newsletter`,
    fromName: clean(f.from_name) || org,
    ...(curator ? { curator } : {}),
  };
}

export const DEFAULT_BRAND: Brand = brandOf();
