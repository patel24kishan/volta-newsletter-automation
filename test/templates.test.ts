import { describe, expect, it } from "vitest";
import { buildDrafts, HTML_CHROME, MERGE_TAGS, offeredSections, whenLine } from "../src/draft/templates.js";
import { itemFromManualEvent } from "../src/manual-events.js";
import { sampleItem } from "./helpers.js";

const TZ = "America/Halifax";
const yoga = sampleItem({
  type: "event", source: "volta-calendar", link: "https://www.eventbrite.ca/e/yoga-1", title: "Yoga", date: "2026-09-24T15:00:00Z",
  summary: "Join us for a 1-hour guided yoga session with Jaimee Lee-Baggley.", location: "Volta, Halifax",
  raw_excerpt: "Yoga Location: Volta, Halifax. Join us for a 1-hour guided yoga session with Jaimee Lee-Baggley.",
  related: [{ source: "volta-linkedin", link: "https://www.linkedin.com/posts/voltaeffect_yoga-activity-1-a", title: "Will we see you next Thursday?" }],
});
const mixer = sampleItem({ type: "event", source: "volta-calendar", link: "https://www.eventbrite.ca/e/mixer", title: "AI Showcase and Mixer", date: "2026-09-16T21:00:00Z", summary: "Join us for an evening of showcasing AI applications.", raw_excerpt: "AI Showcase and Mixer Join us for an evening of showcasing AI applications." });
const post = sampleItem({ type: "linkedin", source: "volta-linkedin", link: "https://www.linkedin.com/posts/voltaeffect_chair-activity-2-b", title: "Pull up a chair and stay awhile.", date: "2026-09-15T11:00:00Z", summary: "Pull up a chair and stay awhile. Coffee, Community & Co-Work at Volta is back on Thursday, October 1.", raw_excerpt: "Pull up a chair and stay awhile. Coffee, Community & Co-Work at Volta is back on Thursday, October 1 from 9:00am - 5:00pm." });
const news = sampleItem({ type: "news", source: "google-news", link: "https://news.google.com/rss/articles/abc", title: "Volta Launches New AI-Focused Program - Entrevestor", date: "2026-09-14T06:57:48Z", summary: "", needs_summary: true, raw_excerpt: "Volta Launches New AI-Focused Program - Entrevestor (Entrevestor)" });

describe("whenLine", () => {
  it("formats in Halifax time with full weekday and month names", () => {
    expect(whenLine(yoga, TZ)).toBe("Thursday, September 24, 12:00 pm");
    expect(whenLine(mixer, TZ)).toBe("Wednesday, September 16, 6:00 pm");
  });
});

describe("buildDrafts", () => {
  const drafts = buildDrafts([mixer, yoga, post, news], { timeZone: TZ });

  it("produces three named drafts that all pass the verifier", () => {
    expect(drafts.map((d) => d.id)).toEqual(["brief", "standard", "events-first"]);
    for (const d of drafts) {
      expect(d.verification.violations, d.id).toEqual([]);
      expect(d.item_ids).toHaveLength(4);
      expect(d.subject).toBe("Volta this week: AI Showcase and Mixer");
    }
  });

  it("every item link and every related link appears in every draft, markdown and html", () => {
    const links = [mixer.link, yoga.link, post.link, news.link, yoga.related![0]!.link];
    for (const d of drafts) for (const l of links) {
      expect(d.markdown, `${d.id} md ${l}`).toContain(l);
      expect(d.html, `${d.id} html ${l}`).toContain(`href="${l}"`);
    }
  });

  it("standard draft carries when, where and summaries; brief carries only titles and links", () => {
    const std = drafts[1]!;
    expect(std.markdown).toContain("When: Thursday, September 24, 12:00 pm");
    expect(std.markdown).toContain("Where: Volta, Halifax");
    expect(std.markdown).toContain("Join us for a 1-hour guided yoga session");
    expect(std.markdown).toContain("[Also covered: Will we see you next Thursday?](https://www.linkedin.com/posts/voltaeffect_yoga-activity-1-a)");
    const brief = drafts[0]!;
    expect(brief.markdown).not.toContain("Join us for a 1-hour");
    expect(brief.markdown).toContain("**Yoga**");
  });

  it("events-first puts events before everything else", () => {
    const md = drafts[2]!.markdown;
    expect(md.indexOf("Yoga")).toBeLessThan(md.indexOf("Pull up a chair"));
    expect(md.indexOf("## Upcoming events")).toBeLessThan(md.indexOf("## In the news"));
  });

  it("says so when a section is empty instead of dropping it, in a sentence a reader would write", () => {
    // A lowercased heading spliced into "No ... items" once printed "No in the news items this week."
    for (const [cadence, period] of [["weekly", "week"], ["monthly", "month"]] as const) {
      for (const d of buildDrafts([post], { timeZone: TZ, cadence })) {
        expect(d.markdown, d.id).toContain(`## Upcoming events\n\nNo upcoming events this ${period}.`);
        expect(d.markdown, d.id).toContain(`## In the news\n\nNo news to report this ${period}.`);
        expect(d.html, d.id).toContain(`No news to report this ${period}.`);
        expect(d.markdown, d.id).not.toMatch(/items this (week|month)/);
        expect(d.verification.violations, d.id).toEqual([]);
      }
      const d = buildDrafts([news], { timeZone: TZ, cadence })[1]!;
      expect(d.markdown).toContain(`## From Volta on LinkedIn\n\nNothing from Volta on LinkedIn this ${period}.`);
      expect(d.html).toContain(`Nothing from Volta on LinkedIn this ${period}.`);
      expect(d.verification.violations).toEqual([]);
    }
  });

  it("shows at most three related links and counts the rest in plain text, markdown and html alike", () => {
    // One real run folded 38 duplicates into a story and printed every one as an "Also covered" link.
    const related = Array.from({ length: 20 }, (_, i) => ({ source: "google-news", link: `https://news.example/story-${i + 1}`, title: `Coverage ${i + 1}` }));
    const story = sampleItem({ type: "news", link: "https://news.example/story", title: "Volta opens a new floor", raw_excerpt: "Volta opens a new floor.", related });
    for (const d of buildDrafts([story], { timeZone: TZ })) {
      expect(d.markdown.match(/\[Also covered: /g), d.id).toHaveLength(3);
      expect(d.markdown, d.id).toContain("[Also covered: Coverage 3](https://news.example/story-3) · and 17 more\n");
      expect(d.markdown, d.id).not.toContain("story-4");
      expect(d.html.match(/Also covered: /g), d.id).toHaveLength(3);
      expect(d.html, d.id).toContain("Coverage 3</a> · and 17 more</div>");
      expect(d.html, d.id).not.toContain("story-4");
      expect(d.verification.violations, d.id).toEqual([]);
    }
  });

  it("a story with three or fewer related links lists them all and says nothing about more", () => {
    const related = Array.from({ length: 3 }, (_, i) => ({ source: "google-news", link: `https://news.example/story-${i + 1}`, title: `Coverage ${i + 1}` }));
    const d = buildDrafts([sampleItem({ related })], { timeZone: TZ })[1]!;
    expect(d.markdown.match(/\[Also covered: /g)).toHaveLength(3);
    expect(d.markdown).not.toMatch(/and \d+ more/);
    expect(d.html).not.toMatch(/and \d+ more/);
    expect(d.verification.violations).toEqual([]);
  });

  it("escapes html and includes the footer when given", () => {
    const evil = sampleItem({ title: 'Tom & Jerry <script>alert("x")</script>', raw_excerpt: 'Tom & Jerry <script>alert("x")</script> body.' });
    const d = buildDrafts([evil], { timeZone: TZ, footer: "Drafted automatically from public sources and reviewed by Bader." })[1]!;
    expect(d.html).toContain("Tom &amp; Jerry &lt;script&gt;");
    expect(d.html).not.toContain("<script>");
    expect(d.html).toContain('<html lang="en"');
    expect(d.markdown.trim().endsWith("reviewed by Bader.")).toBe(true);
    expect(d.verification.ok).toBe(true);
  });

  it("a draft with no items still renders and verifies", () => {
    const ds = buildDrafts([], { timeZone: TZ });
    expect(ds).toHaveLength(3);
    for (const d of ds) expect(d.verification.ok).toBe(true);
    expect(ds[0]!.subject).toBe("Volta this week");
  });
});

describe("email-safe html for Mailchimp", () => {
  const member = sampleItem({
    type: "member_social", source: "member-updates", title: "Acme Robotics", byline: "Jane Doe",
    insights: ["Closed a $1.4M seed round.", "Hired two engineers & a designer."],
    raw_excerpt: "Acme Robotics Closed a $1.4M seed round. Hired two engineers & a designer.",
  });
  const sets = [
    buildDrafts([mixer, yoga, post, news], { timeZone: TZ }),
    buildDrafts([member], { timeZone: TZ }),
    buildDrafts([], { timeZone: TZ }),
  ].flat();

  it("is a table layout with inline styles, an Outlook block and no web-page tags", () => {
    for (const d of sets) {
      expect(d.html.startsWith("<!DOCTYPE html>"), d.id).toBe(true);
      expect(d.html).toContain('role="presentation"');
      expect(d.html).toContain('width="600"');
      expect(d.html).toContain("<!--[if mso]>");
      expect(d.html).not.toMatch(/<main|<article|<script|<link |<img |@import|url\(/i);
    }
  });

  it("carries each required Mailchimp merge tag exactly once, unescaped", () => {
    for (const d of sets) for (const tag of Object.values(MERGE_TAGS)) {
      expect(d.html.split(tag).length - 1, `${d.id} ${tag}`).toBe(1);
    }
    expect(sets[0]!.html).toContain(`href="${MERGE_TAGS.unsub}"`);
  });

  it("says nothing beyond the draft's own blocks plus fixed chrome", () => {
    for (const d of sets) {
      const allowed = new Set(words(`${d.markdown} ${HTML_CHROME.join(" ")}`));
      const stray = words(visibleText(d.html)).filter((w) => !allowed.has(w));
      expect(stray, `${d.id} html words missing from markdown or chrome`).toEqual([]);
    }
  });

  it("keeps every title, bullet and link, and escapes item text", () => {
    const d = buildDrafts([member], { timeZone: TZ })[1]!;
    expect(d.html).toContain("Acme Robotics");
    expect(d.html).toContain("<li");
    expect(d.html).toContain("Hired two engineers &amp; a designer.");
    expect(d.html).toContain(`<title>${d.subject}</title>`);
  });
});

function visibleText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<head>[\s\S]*?<\/head>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\*\|[A-Z_:]+\|\*/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#?\w+;/g, " ");
}

function words(s: string): string[] {
  return s.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

describe("the subject line", () => {
  const monthly = { timeZone: TZ, cadence: "monthly" as const, period: "2026-09" };

  it("names the month, so nothing Bader ticks can become the title of the email", () => {
    for (const d of buildDrafts([mixer, yoga, post, news], monthly)) {
      expect(d.subject, d.id).toBe("Volta this month: September 2026");
      expect(d.verification.violations, d.id).toEqual([]);
    }
  });

  it("is the same whichever item leads the selection", () => {
    const opts = { ...monthly, layouts: ["standard" as const] };
    const a = buildDrafts([yoga, mixer], opts)[0]!;
    const b = buildDrafts([mixer, yoga], opts)[0]!;
    expect(a.subject).toBe(b.subject);
    expect(a.subject).not.toContain("Yoga");
  });

  it("still names the month when nothing is ticked at all", () => {
    expect(buildDrafts([], { ...monthly, layouts: ["standard"] })[0]!.subject).toBe("Volta this month: September 2026");
  });

  it("names the top item when there is no month to name, as a weekly newsletter always has", () => {
    expect(buildDrafts([mixer, yoga], { timeZone: TZ, layouts: ["standard"] })[0]!.subject).toBe("Volta this week: AI Showcase and Mixer");
    expect(buildDrafts([mixer], { timeZone: TZ, cadence: "monthly", layouts: ["standard"] })[0]!.subject).toBe("Volta this month: AI Showcase and Mixer");
  });
});

describe("the order items print in", () => {
  const held = (title: string, date: string) => sampleItem({
    type: "event", source: "volta-calendar", link: `https://e.test/${encodeURIComponent(title)}`, title, date,
    summary: `${title} filled the room.`, raw_excerpt: `${title} ${title} filled the room.`, event_timing: "past",
  });
  // An event Bader added himself, built the way the pipeline builds it, to prove it is placed by
  // its date like any other and not left wherever it was added.
  const added = itemFromManualEvent(
    { id: "me_1", title: "Founder Breakfast", starts_at: "2026-09-20T12:00:00Z", location: "Volta", description: "Founder Breakfast, over coffee.", link: "", image: "", created_at: "2026-09-10T12:00:00Z" },
    { id: "manual-events", type: "event" }, "https://voltaeffect.com/events",
  );
  const opts = { timeZone: TZ, cadence: "monthly" as const, period: "2026-09", layouts: ["events-first" as const] };

  it("prints upcoming events soonest first, an added event among them by its date", () => {
    // Given in the wrong order on purpose: the dates decide, not the selection.
    const d = buildDrafts([yoga, added, mixer], opts)[0]!;
    expect(d.verification.violations).toEqual([]);
    const at = (s: string) => d.markdown.indexOf(s);
    expect(at("AI Showcase and Mixer")).toBeLessThan(at("Founder Breakfast")); // Sep 16, then Sep 20
    expect(at("Founder Breakfast")).toBeLessThan(at("Yoga")); // Sep 20, then Sep 24
  });

  it("prints last month's events most recent first", () => {
    const d = buildDrafts([held("Summer Summit", "2026-09-03T18:00:00Z"), held("Demo Night", "2026-09-17T22:00:00Z")], opts)[0]!;
    expect(d.verification.violations).toEqual([]);
    expect(d.markdown.indexOf("Demo Night")).toBeLessThan(d.markdown.indexOf("Summer Summit"));
  });
});

describe("what an empty section says", () => {
  // The real case: Volta's LinkedIn is read every month, but the page hands back links without the
  // posts' words, so every item is held and none can be ticked. The newsletter used to tell
  // subscribers "Nothing from Volta on LinkedIn this month" while nine posts sat in the list.
  const opts = { timeZone: TZ, cadence: "monthly" as const, period: "2026-09", layouts: ["standard" as const] };

  it("says nothing happened only when there was nothing to choose", () => {
    const md = buildDrafts([mixer], { ...opts, offered: ["Upcoming events"] })[0]!.markdown;
    expect(md).toContain("No news to report this month.");
    expect(md).toContain("Nothing from Volta on LinkedIn this month.");
  });

  it("leaves the heading out when there were items and none were used", () => {
    // The month offered LinkedIn posts and news; only the event was ticked.
    const md = buildDrafts([mixer], { ...opts, offered: ["Upcoming events", "In the news", "From Volta on LinkedIn"] })[0]!.markdown;
    expect(md).not.toContain("Nothing from Volta on LinkedIn");
    expect(md).not.toContain("From Volta on LinkedIn");
    expect(md).not.toContain("No news to report");
    expect(md).not.toContain("In the news");
    // The section that does have something is untouched.
    expect(md).toContain("## Upcoming events");
    expect(md).toContain("AI Showcase and Mixer");
  });

  it("is unchanged when nothing is known about what the month offered", () => {
    const md = buildDrafts([mixer], opts)[0]!.markdown;
    expect(md).toContain("Nothing from Volta on LinkedIn this month.");
  });

  it("reports the headings a period had something for, chosen or not", () => {
    expect(offeredSections([mixer, post, news])).toEqual(["Upcoming events", "In the news", "From Volta on LinkedIn"]);
    expect(offeredSections([])).toEqual([]);
  });
});
