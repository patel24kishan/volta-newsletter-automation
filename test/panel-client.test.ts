/**
 * The panel's script, actually run.
 *
 * Until now this file was guarded only by assertions on its source text, because it runs in a
 * browser frame and `npm run gate` never sees it: tsconfig takes only .ts, and a typo inside the
 * sandbox fails silently — the panel simply does not draw, and the gate stays green. Two defects
 * reached the curator that way. So the script is executed here against a small DOM of our own and
 * a stand-in for the Claude app, and its behaviour is asserted rather than its spelling.
 *
 * The shim is deliberately the few DOM calls panel-client.js actually makes, not a browser.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

class FakeNode {
  readonly nodeType = 1;
  children: Array<FakeNode | FakeText> = [];
  attrs: Record<string, string> = {};
  listeners: Record<string, Array<(e: unknown) => unknown>> = {};
  className = "";
  hidden = false;
  value = "";
  checked = false;
  private text = "";
  constructor(readonly tagName: string) {}
  get textContent(): string {
    return this.text || this.children.map((c) => c.textContent).join("");
  }
  set textContent(v: string) {
    this.children = [];
    this.text = v;
  }
  append(...kids: Array<FakeNode | FakeText>) { for (const k of kids) this.children.push(k); }
  replaceChildren(...kids: Array<FakeNode | FakeText>) {
    // The real DOM turns anything that is not a node into a text node, which is how a stray null
    // would be printed to the curator as the word "null". Keep that faithful.
    this.children = kids.map((k) => (k && typeof k === "object" && "nodeType" in k ? k : new FakeText(String(k))));
    this.text = "";
  }
  setAttribute(k: string, v: string) { this.attrs[k] = String(v); }
  getAttribute(k: string) { return this.attrs[k]; }
  addEventListener(type: string, fn: (e: unknown) => unknown) { (this.listeners[type] ??= []).push(fn); }
  get firstChild() { return this.children[0]; }
  /** Every node in this subtree, so a test can find a button by its words. */
  all(): FakeNode[] {
    return [this, ...this.children.flatMap((c) => (c instanceof FakeNode ? c.all() : []))];
  }
  fire(type: string, event: Record<string, unknown> = {}) {
    for (const fn of this.listeners[type] ?? []) fn({ currentTarget: this, preventDefault() {}, ...event });
  }
}
class FakeText {
  readonly nodeType = 3;
  constructor(public textContent: string) {}
}

/** One group of one item, as list_candidates' structuredContent gives it. */
function panelState(o: { ticked: boolean; total?: number; title?: string }) {
  return {
    periodLabel: "September 2026", dryRun: true, ticked: o.ticked ? 1 : 0, total: o.total ?? 1,
    groups: [{ key: "upcoming", title: "Upcoming events", items: [{
      id: "manual-events:mine", title: o.title ?? "My event", ticked: o.ticked, isEvent: true,
      when: "Thu Oct 8, 1:18 pm", dateLocal: "2026-10-08", timeLocal: "13:18", held: false,
      prints: [], hasPoints: false, notes: [], edited: [], manual: true, link: "https://voltaeffect.com/events",
    }] }],
  };
}

/** Runs panel-client.js with a DOM of our own and a stand-in Claude app. */
async function mount(o: { handed?: ReturnType<typeof panelState>; server: ReturnType<typeof panelState> }) {
  const root = new FakeNode("main");
  root.setAttribute("id", "root");
  const byId = (id: string) => root.all().find((n) => n.attrs.id === id);

  const calls: Array<{ name: string; args: unknown }> = [];
  const sandbox: Record<string, unknown> = {
    setTimeout, clearTimeout, console, Promise, Object, Array, String, Boolean, Number, JSON, Set, Map, RegExp, Error, Date,
    document: {
      getElementById: (id: string) => (id === "root" ? root : byId(id)),
      createElement: (tag: string) => new FakeNode(tag),
      createTextNode: (t: string) => new FakeText(t),
    },
    __mcpApps: {
      App: class {
        ontoolresult?: (r: unknown) => void;
        async connect() {
          // The host may deliver a result during or straight after the handshake. The panel has
          // registered its handler on this object by now, which is why it registers before connecting.
          if (o.handed) this.ontoolresult?.({ structuredContent: o.handed });
        }
        getHostContext() { return undefined; }
        async callServerTool({ name, arguments: args }: { name: string; arguments: unknown }) {
          calls.push({ name, args });
          if (name === "list_candidates") return { content: [], structuredContent: o.server };
          return { content: [{ text: "ok" }] };
        }
        async readServerResource() { return { contents: [] }; }
        async openLink() { return { isError: true }; }
        sendMessage() {}
      },
      applyDocumentTheme() {}, applyHostStyleVariables() {}, applyHostFonts() {},
    },
  };
  sandbox.globalThis = sandbox;

  const source = readFileSync(fileURLToPath(new URL("../src/mcp/panel-client.js", import.meta.url)), "utf8");
  // The script is a module with top-level await, so it runs inside an async function; the handles
  // at the end are the only thing added, and nothing in the body is altered.
  runInNewContext(`globalThis.__started = (async () => {\n${source}\nglobalThis.__state = () => state;\n})();`, sandbox);
  await sandbox.__started;
  // Let the confirmation that connect() set going settle.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  return { root, calls, text: () => root.textContent, state: () => (sandbox.__state as () => unknown)() };
}

describe("the panel, running", () => {
  /**
   * The curator approved a draft, asked for the candidates again, and was shown the selection he
   * had begun the month with: the host had handed the panel a result from earlier in the chat, and
   * the panel had no way to know. The harm is not the display — his next click is then computed
   * against ticks that are not the real ones.
   */
  it("draws what the host hands it, then replaces it with what the server actually holds", async () => {
    const stale = panelState({ ticked: false, title: "My event" });
    const fresh = panelState({ ticked: true, title: "My event" });
    const p = await mount({ handed: stale, server: fresh });

    expect(p.calls.map((c) => c.name)).toContain("list_candidates");
    expect(p.state()).toEqual(fresh);
    const box = p.root.all().find((n) => n.className === "tick")!;
    expect(box.checked, "the tick on screen must be the server's, not the one handed over").toBe(true);
  });

  it("asks for itself when the host hands it nothing, rather than loading for ever", async () => {
    const p = await mount({ server: panelState({ ticked: true }) });
    expect(p.calls.filter((c) => c.name === "list_candidates")).toHaveLength(1);
    expect(p.text()).toContain("My event");
    expect(p.text()).not.toContain("Loading the candidates");
  });

  it("says so when the candidates cannot be read at all", async () => {
    const root = await mount({ server: undefined as never });
    expect(root.text()).toContain("could not be read");
    expect(root.text()).not.toContain("Loading the candidates");
  });

  it("sends a tick as one change, so nothing off screen can be lost", async () => {
    const p = await mount({ server: panelState({ ticked: true, total: 40 }) });
    const box = p.root.all().find((n) => n.className === "tick")!;
    box.checked = false;
    box.fire("change");
    await new Promise((r) => setTimeout(r, 0));
    const sel = p.calls.find((c) => c.name === "set_selection");
    expect(sel?.args).toEqual({ untick: ["manual-events:mine"] });
  });

  it("never prints the word null when a group is not being shown", async () => {
    const p = await mount({ server: panelState({ ticked: true }) });
    expect(p.text()).not.toContain("null");
  });
});
