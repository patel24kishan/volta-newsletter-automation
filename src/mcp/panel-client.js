// The review panel's script: runs inside the Claude app's sandboxed frame, not in Node.
// It talks to the newsletter server only through the host (callServerTool), so every change goes
// through the same tools and rules as the chat. It never builds HTML from data: every value is set
// with textContent, so a title from a source cannot inject markup.
/* global document */
const { App, applyDocumentTheme, applyHostStyleVariables, applyHostFonts } = globalThis.__mcpApps;

const app = new App({ name: "Volta newsletter review", version: "1.0.0" });
const root = document.getElementById("root");
let state = null;
let draft = null;
let working = false;

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

function setStatus(message, isError) {
  const s = document.getElementById("status");
  if (!s) return;
  s.textContent = message || "";
  s.className = isError ? "status error" : "status";
}

async function call(name, args) {
  working = true;
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
  } finally {
    working = false;
  }
}

async function refresh() {
  const r = await call("list_candidates", {});
  if (r && r.structuredContent) {
    state = r.structuredContent;
    render();
  }
}

async function saveTicks() {
  const ids = [...root.querySelectorAll("input.tick:checked")].map((i) => i.value);
  if (await call("set_selection", { select: ids })) await refresh();
}

function render() {
  if (!state) return;
  root.replaceChildren(
    el("div", { class: "head" },
      el("strong", {}, `${state.periodLabel} newsletter`),
      el("span", { class: "muted", id: "count" }, `${state.ticked} of ${state.total} ticked`),
      state.dryRun ? el("span", { class: "badge" }, "dry run") : null),
    el("div", { id: "status", class: "status", role: "status", "aria-live": "polite" }),
    ...state.groups.map(group),
    addEventForm(),
    buildBar(),
  );
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
      el("input", { type: "checkbox", class: "tick", value: it.id, checked: it.ticked, "aria-label": `Include ${it.title}`, onchange: () => { if (!working) saveTicks(); } }),
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
    } }, "Back to the source's wording") : null));
  return form;
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
    if (await call("add_event", args)) await refresh();
  } },
  ...input("title", "Title", "text"), ...input("date", "Date", "date"), ...input("time", "Time", "time"),
  ...input("location", "Location (optional)", "text"), ...input("description", "Description (optional)", "textarea"),
  ...input("link", "Link (optional)", "url"), ...input("image", "Image: https link or file path (optional)", "text"),
  el("button", { type: "submit" }, "Add the event"));
  return el("details", { class: "add" }, el("summary", {}, "Add an event"), form);
}

function buildBar() {
  const out = el("div", { class: "draft" });
  if (draft) out.append(
    el("div", {}, el("strong", {}, "Draft: "), draft.subject),
    ...draft.notes.filter(Boolean).map((n) => el("div", { class: "note" }, n.replace(/\*\*/g, ""))),
    el("div", { class: "row" },
      draft.previewUrl ? el("button", { type: "button", onclick: () => app.openLink({ url: draft.previewUrl }) }, "Open preview") : null,
      el("button", { type: "button", onclick: () => app.sendMessage({ role: "user", content: [{ type: "text", text: `Show me the draft I just built in the panel (draft key ${draft.key}) exactly as it is, with its preview link.` }] }) }, "Show it in the chat"),
      el("button", { type: "button", onclick: () => app.sendMessage({ role: "user", content: [{ type: "text", text: `I'd like to approve the draft I built in the panel (draft key ${draft.key}). Please confirm with me first.` }] }) }, "Approve…")));
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
