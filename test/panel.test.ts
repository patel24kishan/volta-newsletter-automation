/**
 * The review panel (MCP App): the page served to the Claude app, and the data it draws.
 */
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { panelItem, panelState } from "../src/mcp/newsletter-server.js";
import { rankItems } from "../src/pipeline/rank.js";
import { startReview, type ReviewState } from "../src/review/review.js";
import { SqliteStorage } from "../src/storage.js";
import { exposeExports, PANEL_MIME, PANEL_URI, panelHtml, PREVIEW_URI } from "../src/mcp/panel.js";
import { sampleItem } from "./helpers.js";

const TZ = "America/Halifax";

describe("the panel page", () => {
  it("turns the library's export statement into names the panel script can read", () => {
    const out = exposeExports("var a=1;function c(){};export{a as App,c};");
    expect(out).toBe("var a=1;function c(){};Object.assign(globalThis.__mcpApps||(globalThis.__mcpApps={}),{App:a,c:c});");
    expect(() => exposeExports("var a=1;")).toThrow(/no export statement/);
  });

  it("is one self-contained page: the library and the panel script, nothing loaded from outside", () => {
    const html = panelHtml();
    expect(PANEL_URI).toBe("ui://volta-newsletter/review-panel.html");
    expect(PANEL_MIME).toBe("text/html;profile=mcp-app");
    expect(html.match(/<script type="module">/g)).toHaveLength(2);
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/<link[^>]+href=/);
    expect(html).toContain('<main id="root">');
    expect(html).toContain('callServerTool({ name, arguments: args })');
  });

  it("shows the newsletter itself rather than depending on the host to open a loopback address", () => {
    const html = panelHtml();
    // Read from the server as a resource, so the rendered email never travels through the chat.
    expect(html).toContain(PREVIEW_URI);
    expect(html).toContain('readServerResource({ uri: PREVIEW_URI })');
    // srcdoc, never src: the sandbox loads nothing over the network.
    expect(html).toContain('srcdoc: html');
    expect(html).not.toMatch(/iframe[^)]*src:/);
  });

  it("answers when the host refuses to open the preview address, instead of going quiet", () => {
    const html = panelHtml();
    // openLink resolves with isError rather than throwing; the old handler ignored the result.
    expect(html).toContain('if (r && r.isError) setStatus(');
    expect(html).toContain('await app.openLink({ url: draft.previewUrl })');
    // And the address is on the page whatever the host does.
    expect(html).toContain('In a browser: ');
    expect(html).toContain('the preview server did not start');
  });

  it("exposes the library's App once the library has run", () => {
    const html = panelHtml();
    const library = /<script type="module">([\s\S]*?)<\/script>/.exec(html)![1]!;
    expect(library).not.toMatch(/export\s*\{/);
    // The standard globals a browser (and Node) provides; nothing from the Claude app.
    const sandbox: Record<string, unknown> = { URL, URLSearchParams, TextEncoder, TextDecoder, AbortController, setTimeout, clearTimeout, console, crypto: globalThis.crypto };
    sandbox.globalThis = sandbox;
    sandbox.self = sandbox;
    runInNewContext(library, sandbox);
    const apps = sandbox.__mcpApps as Record<string, unknown>;
    expect(typeof apps.App).toBe("function");
    expect(typeof apps.applyDocumentTheme).toBe("function");
  });
});

describe("what the panel draws for an item", () => {
  it("an upcoming event: readable date, form values in Halifax time, location and link", () => {
    const ev = sampleItem({ type: "event", title: "Fall Mixer", date: "2026-10-22T21:00:00Z", location: "Volta", link: "https://e.test/m", summary: "Meet the fall cohort.", event_timing: "upcoming" });
    expect(panelItem(ev, true, TZ)).toMatchObject({
      title: "Fall Mixer", ticked: true, isEvent: true, when: "Thu Oct 22, 6:00 pm", dateLocal: "2026-10-22", timeLocal: "18:00",
      location: "Volta", prints: ["Meet the fall cohort."], hasPoints: false, notes: [], held: false, manual: false, link: "https://e.test/m",
    });
  });

  it("a past event says it was held", () => {
    const past = sampleItem({ type: "event", date: "2026-09-17T22:00:00Z", event_timing: "past" });
    expect(panelItem(past, false, TZ).when).toBe("held Thu Sep 17, 7:00 pm");
  });

  it("a held founder update: its points print, its advice is a note, and the hold is shown", () => {
    const held = sampleItem({
      type: "member_social", title: "Bellwether Soil", requires_review: true, hold_note: "Embargo until Sep 30",
      summary: "Run it after the funder announces.", insights: ["Won a soil-health grant."], editor_notes: ["Check the grant amount."],
    });
    expect(panelItem(held, false, TZ)).toMatchObject({
      held: true, holdNote: "Embargo until Sep 30", prints: ["Won a soil-health grant."], hasPoints: true,
      notes: ["Run it after the funder announces.", "Check the grant amount."], when: "2026-09-14",
    });
  });

  it("an event Bader added is marked as his, with its image and edits", () => {
    const mine = sampleItem({ type: "event", source: "manual-events", source_ref: "manual:me_1", image: "https://cdn.test/p.png", edited_fields: ["title"] });
    expect(panelItem(mine, true, TZ)).toMatchObject({ manual: true, image: "https://cdn.test/p.png", edited: ["title"] });
  });
});

describe("ticking a box when the panel is showing one group", () => {
  /**
   * The panel used to save the selection as "exactly the boxes I can see". list_candidates takes a
   * group, and Claude can narrow the list in the chat without Bader asking, so one click in that
   * view unticked every item off screen with nothing said and no way back to the pre-ticked list.
   */
  it("sends the one change, never the whole selection rebuilt from what is on screen", () => {
    const html = panelHtml();
    expect(html).toContain('call("set_selection", checked ? { tick: [id] } : { untick: [id] })');
    expect(html).not.toContain("input.tick:checked");
    expect(html).not.toContain('set_selection", { select:');
  });

  it("queues a second click instead of dropping it, and puts the box back if the change fails", () => {
    const html = panelHtml();
    expect(html).toContain("pending = pending.then(");
    // The old guard: a click arriving mid-call was ignored, which looked like the box not taking.
    expect(html).not.toContain("if (!working)");
    expect(html).toContain("else render();");
  });

  it("says the view is narrowed, and offers the way back", () => {
    const html = panelHtml();
    expect(html).toContain("if (!state.showing) return null;");
    // Both scopes named: how much of the month is on screen, and that the tick count covers the
    // rest. Saying only the second was read as the first, and the curator asked what he was missing.
    expect(html).toContain("of ${state.total} candidates.");
    expect(html).toContain("counted across every group, including the ones not shown.");
    expect(html).toContain("Nothing is ticked, in this group or any other.");
    expect(html).toContain("Show every group");
    // And a refresh keeps the group being shown rather than silently widening it.
    expect(html).toContain('call("list_candidates", want && want !== "all" ? { group: want } : {})');
    // Except after adding an event, which would land outside a view narrowed to the news.
    expect(html).toContain('call("add_event", args)) await refresh("all")');
  });

  it("keeps a message on screen through the redraw that follows it", () => {
    const html = panelHtml();
    // render() replaces #root, so the #status node the message was written to is thrown away.
    expect(html).toContain("function paintStatus()");
    expect(html).toMatch(/root\.replaceChildren\([\s\S]*?\);\n {2}paintStatus\(\);/);
  });

  it("never hands the DOM a missing child, which would print as the word null", () => {
    // replaceChildren takes nodes or strings: showingLine() returns null when nothing is narrowed.
    expect(panelHtml()).toContain("].filter(Boolean));");
  });
});

describe("the state the panel is given", () => {
  const RUN = new Date("2026-10-01T11:30:00Z");
  const mixer = sampleItem({ type: "event", link: "https://e.test/m", title: "Fall Mixer", date: "2026-10-22T21:00:00Z", event_timing: "upcoming" });
  const held = sampleItem({ type: "event", link: "https://e.test/d", title: "Demo Night", date: "2026-09-17T22:00:00Z", event_timing: "past" });
  const story = sampleItem({ link: "https://news.test/a", title: "Volta launches a program" });

  function review(storage: SqliteStorage): ReviewState {
    const st: ReviewState = {
      candidates: [], timeZone: TZ, outDir: ".", drafts: new Map(), selections: new Map(), env: {}, campaigns: new Set(),
      session: storage, edits: storage, week: "2026-10", layout: "events-first", cadence: "monthly", now: () => RUN,
    };
    startReview(st, {
      candidates: rankItems([mixer, held, story], RUN), preselectedIds: [mixer.id, story.id], period: "2026-10",
      firstWorkday: { date: "2026-10-01", weekday: "thursday", weekMonday: "2026-09-28", skipped: [] },
      timeZone: TZ, clockLabel: "test", sourceNotes: [],
    });
    return st;
  }

  let storage: SqliteStorage;
  beforeEach(() => { storage = new SqliteStorage(":memory:"); });
  afterEach(() => storage.close());

  it("draws all three groups, with the period and the mode, when nothing was narrowed", () => {
    const p = panelState(review(storage), "month", TZ, false);
    expect(p).toMatchObject({ periodLabel: "October 2026", dryRun: true, ticked: 2, total: 3 });
    expect(p.groups.map((g) => g.key)).toEqual(["upcoming", "past", "other"]);
    expect(p.showing).toBeUndefined();
    expect(panelState(review(storage), "month", TZ, false, "all").showing).toBeUndefined();
  });

  /**
   * The counts stay whole while the groups are narrowed, and the narrowing is named. A panel that
   * draws part of the month without saying so is read as the whole of it.
   */
  it("names the group it was narrowed to, and still counts the whole period", () => {
    const p = panelState(review(storage), "month", TZ, false, "upcoming");
    expect(p.showing).toBe("upcoming");
    expect(p.groups.map((g) => g.key)).toEqual(["upcoming"]);
    expect(p.groups[0]!.items.map((i) => i.title)).toEqual(["Fall Mixer"]);
    expect({ ticked: p.ticked, total: p.total }).toEqual({ ticked: 2, total: 3 });
  });
});
