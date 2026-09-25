/**
 * The names the newsletter uses, and the set-up that changes them. Volta is what an untouched
 * database means; a friend's install says otherwise once, in chat, and the change reaches every
 * printed and spoken name without a restart.
 */
import { describe, expect, it } from "vitest";
import { brandOf, DEFAULT_BRAND } from "../src/brand.js";
import { isSetUp, merged, readSettings, saveSetup, settingsStatusLine, setupPreview, validateSetup, type Settings } from "../src/settings.js";
import { SqliteStorage } from "../src/storage.js";

describe("the brand", () => {
  it("is Volta's when nothing is set", () => {
    expect(DEFAULT_BRAND).toEqual({ org: "Volta", newsletter: "Volta Newsletter", fromName: "Volta" });
    expect(brandOf({})).toEqual(DEFAULT_BRAND);
    expect(brandOf({ organisation: "  ", curator_name: "" })).toEqual(DEFAULT_BRAND);
  });

  it("derives the newsletter and sender names from the organisation unless they are given", () => {
    expect(brandOf({ organisation: "Acme", curator_name: "Sam" })).toEqual({ org: "Acme", newsletter: "Acme Newsletter", fromName: "Acme", curator: "Sam" });
    expect(brandOf({ organisation: "Acme", newsletter_name: "The Acme Monthly", from_name: "Acme Team" })).toMatchObject({ newsletter: "The Acme Monthly", fromName: "Acme Team" });
  });
});

describe("set-up", () => {
  it("needs the organisation and the curator's name, and refuses a timezone the computer does not know", () => {
    expect(validateSetup({})).toEqual([
      'Organisation is needed: the name the newsletter is from (for example "Volta").',
      "Your name is needed, so the reminder can greet you.",
    ]);
    expect(validateSetup({ organisation: "Acme", curator_name: "Sam" })).toEqual([]);
    expect(validateSetup({ organisation: "Acme", curator_name: "Sam", timezone: "Mars/Olympus" })).toEqual(['"Mars/Olympus" is not a timezone this computer knows. Use an IANA name such as America/Halifax or Europe/London.']);
    expect(validateSetup({ organisation: "Acme", curator_name: "Sam", timezone: "Europe/London" })).toEqual([]);
    expect(validateSetup({ organisation: "x".repeat(81), curator_name: "Sam\nJones" })).toEqual([
      "Organisation is too long (81 characters; 80 at most).",
      "Your name must be one line.",
    ]);
  });

  it("previews what would change, naming what it was", () => {
    const lines = setupPreview({}, { organisation: "Acme", curator_name: "Sam" }, "America/Halifax");
    expect(lines).toEqual([
      "Organisation: Acme (was Volta)",
      "Newsletter: Acme Newsletter (was Volta Newsletter)",
      "Curator: Sam",
      "Sender name on the email: Acme (MAILCHIMP_FROM_NAME overrides this when it is set)",
      'Where these show: the email\'s subject ("Acme this month: …"), its headings, masthead and footer, and the reminder\'s greeting.',
    ]);
    const tz = setupPreview({ organisation: "Acme", curator_name: "Sam", set_up_at: "x" }, { timezone: "Europe/London" }, "America/Halifax");
    expect(tz).toContain("Timezone: Europe/London (was America/Halifax; applies when the host next starts the server)");
    expect(tz[0]).toBe("Organisation: Acme");
  });

  it("keeps a field that is left out", () => {
    const current: Settings = { organisation: "Acme", curator_name: "Sam", newsletter_name: "The Acme Monthly" };
    expect(merged(current, { curator_name: "Alex" })).toEqual({ organisation: "Acme", curator_name: "Alex", newsletter_name: "The Acme Monthly" });
  });

  it("saves to the database, survives reopening it, and marks the newsletter as set up", () => {
    const s = new SqliteStorage(":memory:");
    expect(isSetUp(readSettings(s))).toBe(false);
    expect(settingsStatusLine(readSettings(s))).toBe('Not set up yet: running as "Volta" with no curator name. Say "set up the newsletter" to name the organisation, the newsletter and yourself; it applies at once and survives updates.');
    saveSetup(s, { organisation: "Acme", curator_name: "Sam", timezone: "Europe/London" }, "2026-10-01T12:00:00Z");
    const after = readSettings(s);
    expect(isSetUp(after)).toBe(true);
    expect(after).toEqual({ organisation: "Acme", curator_name: "Sam", timezone: "Europe/London", set_up_at: "2026-10-01T12:00:00Z" });
    expect(settingsStatusLine(after)).toBe("Newsletter: Acme Newsletter (Acme), curator Sam, timezone Europe/London.");
    // A second set-up that names only the curator keeps the organisation.
    saveSetup(s, { curator_name: "Alex" }, "2026-10-02T12:00:00Z");
    expect(brandOf(readSettings(s))).toMatchObject({ org: "Acme", curator: "Alex" });
    s.close();
  });
});
