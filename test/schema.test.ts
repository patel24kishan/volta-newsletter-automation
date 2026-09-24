import { describe, expect, it } from "vitest";
import { itemId, normalizeLink, validateItem } from "../src/schema.js";
import { sampleItem } from "./helpers.js";

describe("validateItem", () => {
  it("accepts a complete item", () => {
    expect(validateItem(sampleItem())).toEqual({ ok: true, errors: [] });
  });

  it("rejects a missing or relative link (constraint 5: every item carries its source link)", () => {
    expect(validateItem(sampleItem({ link: "" })).ok).toBe(false);
    expect(validateItem(sampleItem({ link: "/relative" })).ok).toBe(false);
    expect(validateItem(sampleItem({ link: "ftp://x" })).ok).toBe(false);
  });

  it("rejects a date without timezone", () => {
    const r = validateItem(sampleItem({ date: "2026-09-14" }));
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toMatch(/date/);
  });

  it("requires needs_summary=true when summary is empty", () => {
    expect(validateItem(sampleItem({ summary: "", needs_summary: false })).ok).toBe(false);
    expect(validateItem(sampleItem({ summary: "", needs_summary: true })).ok).toBe(true);
  });

  it("rejects unknown type and confidence", () => {
    expect(validateItem({ ...sampleItem(), type: "rumour" }).ok).toBe(false);
    expect(validateItem({ ...sampleItem(), confidence: "certain" }).ok).toBe(false);
  });

  it("rejects non-objects", () => {
    expect(validateItem(null).ok).toBe(false);
    expect(validateItem("x").ok).toBe(false);
  });
});

describe("itemId", () => {
  it("is deterministic for the same source and link", () => {
    expect(itemId("a", "https://x/1")).toBe(itemId("a", "https://x/1"));
  });
  it("differs across sources and links", () => {
    expect(itemId("a", "https://x/1")).not.toBe(itemId("b", "https://x/1"));
    expect(itemId("a", "https://x/1")).not.toBe(itemId("a", "https://x/2"));
  });
});

describe("normalizeLink", () => {
  it("fills in the scheme people leave off", () => {
    expect(normalizeLink("www.eventbrite.ca/e/demo-night-1")).toBe("https://www.eventbrite.ca/e/demo-night-1");
    expect(normalizeLink("voltaeffect.com/events")).toBe("https://voltaeffect.com/events");
    expect(normalizeLink("  lu.ma/mixer  ")).toBe("https://lu.ma/mixer");
    expect(normalizeLink("example.co.uk/a?b=1#c")).toBe("https://example.co.uk/a?b=1#c");
  });

  it("leaves a link that already has one exactly as it is", () => {
    expect(normalizeLink("https://voltaeffect.com/events")).toBe("https://voltaeffect.com/events");
    expect(normalizeLink("http://old.example.com/x")).toBe("http://old.example.com/x");
    expect(normalizeLink(" https://lu.ma/mixer ")).toBe("https://lu.ma/mixer");
  });

  it("hands back anything it cannot repair, so the caller's own message is what is shown", () => {
    for (const bad of ["", "   ", "not a link", "a link to the page", "eventbrite", "mailto:hi@volta.test", "ftp://files.test/x"]) {
      expect(normalizeLink(bad), bad).toBe(bad.trim());
    }
  });
});
