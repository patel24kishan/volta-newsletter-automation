// The review panel's script: runs inside the Claude app's sandboxed frame, not in Node.
// It talks to the newsletter server only through the host (callServerTool), so every change goes
// through the same tools and rules as the chat. It never builds HTML from data: every value is set
// with textContent, so a title from a source cannot inject markup.
const { App, applyDocumentTheme, applyHostStyleVariables, applyHostFonts } = globalThis.__mcpApps;

const app = new App({ name: "Volta newsletter review", version: "1.0.0" });
const root = document.getElementById("root");
let state = null;
let draft = null;

// Registered before connecting: the host may send the list's result straight after the handshake.
app.ontoolresult = (r) => {
  if (r.structuredContent && r.structuredContent.groups) {
    state = r.structuredContent;
    render();
  }
};
app.onhostcontextchanged = (ctx) => applyContext(ctx);

function applyContext(ctx) {
  if (!ctx) return;
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles && ctx.styles.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.styles && ctx.styles.css && ctx.styles.css.fonts) applyHostFonts(ctx.styles.css.fonts);
}

function el(tag, attrs, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (k === "checked" || k === "disabled") n[k] = Boolean(v);
    else n.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) if (c !== undefined && c !== null && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c)));
  return n;
}

// Kept here as well as on the page: render() replaces #root wholesale, so the node this is written
// to is thrown away and rebuilt empty. A message about the change that just failed has to outlive
// the redraw that follows it, or the panel reports its own errors to nobody.
let status = { message: "", error: false };

function setStatus(message, isError) {
  status = { message: message || "", error: Boolean(isError) };
  paintStatus();
}

function paintStatus() {
  const s = document.getElementById("status");
  if (!s) return;
  s.textContent = status.message;
  s.className = status.error ? "status error" : "status";
}

async function call(name, args) {
  setStatus("Working…");
  try {
    const r = await app.callServerTool({ name, arguments: args });
    const text = (r.content || []).map((c) => c.text || "").join("\n");
    if (r.isError) {
      setStatus(text, true);
      return null;
    }
    setStatus("");
    return r;
  } catch (e) {
    setStatus(String((e && e.message) || e), true);
    return null;
  }
}

/** Reads the list again, keeping whichever group is being shown unless asked for "all". */
async function refresh(group) {
  const want = group === undefined ? state && state.showing : group;
  const r = await call("list_candidates", want && want !== "all" ? { group: want } : {});
  if (r && r.structuredContent) {
    state = r.structuredContent;
    render();
  }
}

/**
 * A tick is sent as the one change it is, never as "the selection is now exactly the boxes I can
 * see". The panel is often drawing a single group — list_candidates takes one, and Claude can
 * narrow it in the chat without Bader asking — and a whole-selection save from that view unticked
 * every item off screen, silently and with no way back to the pre-ticked list.
 *
 * Clicks are queued rather than dropped. The old guard ignored a second tick that arrived while the
 * first was still in flight, which to Bader looked like the box simply refusing to take.
 */
let pending = Promise.resolve();

function changeTick(id, checked) {
  pending = pending.then(() => saveTick(id, checked), () => saveTick(id, checked));
  return pending;
}

async function saveTick(id, checked) {
  if (await call("set_selection", checked ? { tick: [id] } : { untick: [id] })) await refresh();
  // It did not take: draw the list as the server last gave it, so the box goes back to the truth
  // rather than showing a change that was never saved. The reason stays on screen.
  else render();
}

function render() {
  if (!state) return;
  // Filtered, not passed straight through: replaceChildren takes nodes or strings, so a null from
  // showingLine() would be printed to Bader as the word "null". el() does this for its own
  // children; this is the one place that calls the DOM directly.
  root.replaceChildren(...[
    el("div", { class: "head" },
      el("strong", {}, `${state.periodLabel} newsletter`),
      el("span", { class: "muted", id: "count" }, `${state.ticked} of ${state.total} ticked`),
      state.dryRun ? el("span", { class: "badge" }, "dry run") : null),
    el("div", { id: "status", class: "status", role: "status", "aria-live": "polite" }),
    showingLine(),
    ...state.groups.map(group),
    addEventForm(),
    buildBar(),
  ].filter(Boolean));
  paintStatus();
}

/**
 * Said out loud whenever one group was asked for. The head counts the whole period while the list
 * is a part of it, and the two numbers are easily read as one: shown a single group with three
 * ticked elsewhere, the curator asked where the other two items were. So both scopes are named —
 * how much of the month is on screen, and that the tick count covers what is not.
 */
function showingLine() {
  if (!state.showing) return null;
  const title = (state.groups[0] && state.groups[0].title) || "one group";
  const shown = state.groups.reduce((n, g) => n + g.items.length, 0);
  const counted = state.ticked === 0
    ? "Nothing is ticked, in this group or any other."
    : `${state.ticked === 1 ? "The one ticked item is" : `All ${state.ticked} ticked items are`} counted across every group, including the ones not shown.`;
  return el("div", { class: "note" },
    `Showing ${title.toLowerCase()} only — ${shown} of ${state.total} candidates. ${counted} `,
    el("button", { type: "button", class: "link", onclick: () => refresh("all") }, "Show every group"));
}

function group(g) {
  return el("section", {},
    el("h3", {}, `${g.title} (${g.items.length})`),
    g.items.length ? el("ul", { class: "items" }, g.items.map(item)) : el("p", { class: "muted" }, "None."));
}

function item(it) {
  const editor = el("div", { class: "editor", hidden: true });
  const row = el("li", { class: it.held ? "held" : "" },
    el("label", { class: "line" },
      el("input", { type: "checkbox", class: "tick", value: it.id, checked: it.ticked, "aria-label": `Include ${it.title}`, onchange: (e) => changeTick(it.id, e.currentTarget.checked) }),
      el("span", { class: "title" },
        it.held ? el("span", { class: "tag hold" }, "MARKED FOR REVIEW") : null,
        it.title),
      el("span", { class: "muted" }, it.when),
      it.edited.length ? el("span", { class: "tag" }, "edited") : null,
      it.image ? el("span", { class: "tag" }, "image") : null),
    el("div", { class: "detail" },
      it.location ? el("div", { class: "muted" }, `Where: ${it.location}`) : null,
      it.prints.length ? el("ul", { class: "prints" }, it.prints.map((p) => el("li", {}, p))) : el("div", { class: "muted" }, "Prints the title only (the source gave no description)."),
      it.holdNote ? el("div", { class: "hold-note" }, `On hold: ${it.holdNote}`) : null,
      ...it.notes.map((n) => el("div", { class: "note" }, `Note to editor (not printed): ${n}`)),
      el("button", { type: "button", class: "link", "aria-expanded": "false", onclick: (e) => toggle(e.currentTarget, editor, it) }, "Edit wording")),
    editor);
  return row;
}

function toggle(button, editor, it) {
  const open = editor.hidden;
  editor.hidden = !open;
  button.setAttribute("aria-expanded", String(open));
  if (open) editor.replaceChildren(editForm(it));
}

/** The fields this item can have changed, in the curator's words. */
function editForm(it) {
  const fields = [["summary", "Description", it.prints.length === 1 && !it.hasPoints ? it.prints[0] : "", "textarea"]];
  if (it.isEvent) fields.push(["starts_at", "Date and time (YYYY-MM-DD HH:MM)", `${it.dateLocal} ${it.timeLocal}`, "input"], ["location", "Location", it.location || "", "input"]);
  fields.push(["link", "Link", it.link, "input"]);
  // Title and image belong to events the curator added; a source's own title is kept.
  if (it.manual) {
    fields.unshift(["title", "Title", it.title, "input"]);
    fields.push(["image", "Image (https link or file path)", it.image || "", "input"]);
  }
  const inputs = {};
  const form = el("form", { class: "form", onsubmit: async (e) => {
    e.preventDefault();
    for (const [field, , original] of fields) {
      const value = inputs[field].value.trim();
      if (value === String(original).trim() || value === "") continue;
      if (!(await call("edit_item", { item_id: it.id, field, text: value }))) return;
    }
    await refresh();
  } });
  for (const [field, label, value, kind] of fields) {
    const id = `f-${it.id}-${field}`.replace(/[^a-zA-Z0-9-]/g, "_");
    inputs[field] = el(kind, { id, name: field, rows: kind === "textarea" ? 3 : undefined });
    inputs[field].value = value;
    form.append(el("label", { for: id }, label), inputs[field]);
  }
  form.append(el("div", { class: "row" },
    el("button", { type: "submit" }, "Save changes"),
    it.edited.length ? el("button", { type: "button", onclick: async () => {
      for (const field of it.edited) if (!(await call("edit_item", { item_id: it.id, field, clear: true }))) return;
      await refresh();
    } }, "Back to the source's wording") : null,
    // Only on events Bader added: an item from a source is unticked, never deleted.
    it.manual ? removeButton(it) : null));
  return form;
}

/**
 * Removing takes two clicks: the first arms the button, the second does it. A browser dialog would
 * be the obvious way to ask, but this frame is sandboxed and the host need not allow modals, so a
 * silently ignored confirm would either delete without asking or never delete at all.
 */
function removeButton(it) {
  const b = el("button", { type: "button", onclick: async () => {
    if (b.className !== "danger") {
      b.className = "danger";
      b.textContent = "Really remove it?";
      return;
    }
    if (await call("remove_event", { item_id: it.id, confirm: true })) await refresh();
  } }, "Remove this event");
  return b;
}

function addEventForm() {
  const f = {};
  const input = (name, label, type) => {
    const id = `add-${name}`;
    f[name] = el(type === "textarea" ? "textarea" : "input", { id, name, type: type === "textarea" ? undefined : type, rows: type === "textarea" ? 3 : undefined });
    return [el("label", { for: id }, label), f[name]];
  };
  const form = el("form", { class: "form", onsubmit: async (e) => {
    e.preventDefault();
    const args = { title: f.title.value.trim(), date: f.date.value, time: f.time.value };
    for (const k of ["location", "description", "link", "image"]) if (f[k].value.trim()) args[k] = f[k].value.trim();
    // Widens the view: an added event is always an event, so adding one from a panel narrowed to
    // the news would otherwise look as though nothing had happened.
    if (await call("add_event", args)) await refresh("all");
  } },
  ...input("title", "Title", "text"), ...input("date", "Date", "date"), ...input("time", "Time", "time"),
  ...input("location", "Location (optional)", "text"), ...input("description", "Description (optional)", "textarea"),
  // A text box, not type="url": the browser would refuse "www.eventbrite.com" with its own bubble
  // before the form was ever sent, and say nothing useful. The server fills in the scheme and has
  // a sentence to give back when it really cannot be read. The edit form already does it this way.
  ...input("link", "Link (optional)", "text"), ...input("image", "Image: https link or file path (optional)", "text"),
  el("button", { type: "submit" }, "Add the event"));
  return el("details", { class: "add" }, el("summary", {}, "Add an event"), form);
}

/**
 * The newsletter, shown in the panel itself.
 *
 * "Open preview" used to hand the preview server's address to the host and hope. The host will not
 * open `http://127.0.0.1:3111/...` — its capability is for opening *external* links — and openLink
 * reports that by resolving with isError rather than throwing, which the old handler discarded. So
 * the button did nothing and said nothing.
 *
 * Reading the draft as a resource and showing it here needs nothing from the host, so it works the
 * same in dry run on this laptop as it would hosted. Opening it in a real browser stays available
 * as well: that is the path that works once PUBLIC_URL makes the address an external https one.
 */
const PREVIEW_URI = "ui://volta-newsletter/current-draft.html";

function previewBox() {
  return el("div", { id: "preview" });
}

async function showPreview() {
  const box = document.getElementById("preview");
  if (!box) return;
  if (box.firstChild) {
    box.replaceChildren();
    return;
  }
  setStatus("Rendering the newsletter…");
  try {
    const r = await app.readServerResource({ uri: PREVIEW_URI });
    const html = (r.contents || []).map((c) => c.text || "").join("");
    if (!html) {
      setStatus("There is no built draft to show yet. Build it first.", true);
      return;
    }
    // srcdoc, not src: the frame carries the document with it, so nothing is loaded over the
    // network from a sandbox that forbids exactly that.
    box.replaceChildren(el("iframe", { class: "preview", srcdoc: html, sandbox: "", title: "The newsletter as it will look" }));
    setStatus("");
  } catch (e) {
    setStatus(`The newsletter could not be shown here: ${(e && e.message) || e}`, true);
  }
}

async function openPreview() {
  try {
    const r = await app.openLink({ url: draft.previewUrl });
    // The host says no by answering, not by throwing. Saying nothing is what made this look broken.
    if (r && r.isError) setStatus(`This app would not open ${draft.previewUrl}. Use "Show the newsletter", or paste that address into a browser.`, true);
    else setStatus("");
  } catch (e) {
    setStatus(`${draft.previewUrl} could not be opened: ${(e && e.message) || e}`, true);
  }
}

function buildBar() {
  const out = el("div", { class: "draft" });
  if (draft) out.append(
    el("div", {}, el("strong", {}, "Draft: "), draft.subject),
    ...draft.notes.filter(Boolean).map((n) => el("div", { class: "note" }, n.replace(/\*\*/g, ""))),
    previewBox(),
    el("div", { class: "row" },
      el("button", { type: "button", onclick: showPreview }, "Show the newsletter"),
      draft.previewUrl ? el("button", { type: "button", onclick: openPreview }, "Open in a browser") : null,
      el("button", { type: "button", onclick: () => app.sendMessage({ role: "user", content: [{ type: "text", text: `Show me the draft I just built in the panel (draft key ${draft.key}) exactly as it is, with its preview link.` }] }) }, "Show it in the chat"),
      el("button", { type: "button", onclick: () => app.sendMessage({ role: "user", content: [{ type: "text", text: `I'd like to approve the draft I built in the panel (draft key ${draft.key}). Please confirm with me first.` }] }) }, "Approve…")),
    // Always shown, never only on failure: a status line is wiped by the next refresh, and an
    // address he can read and copy is the one thing that works whatever the host allows.
    draft.previewUrl
      ? el("div", { class: "note" }, "In a browser: ", el("code", { class: "addr" }, draft.previewUrl))
      : el("div", { class: "note" }, "There is no preview address this time: the preview server did not start. \"Show the newsletter\" still works."));
  return el("div", { class: "actions" },
    el("button", { type: "button", class: "primary", onclick: async () => {
      const r = await call("build_draft", {});
      if (r && r.structuredContent) {
        draft = r.structuredContent;
        render();
      }
    } }, draft ? "Rebuild the draft" : "Build the draft"),
    out);
}

await app.connect();
applyContext(app.getHostContext());
