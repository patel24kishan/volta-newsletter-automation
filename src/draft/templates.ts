/**
 * Draft templates. No LLM (back burner): every word in a draft is either a fixed template phrase
 * (allowlisted for the verifier) or text copied from an item. Three layouts give Bader a choice:
 *   brief        one line per item, links only
 *   standard     sections with summary, when and where
 *   events-first events with full details on top, everything else below
 * Sections with nothing say so instead of vanishing (constraint 5).
 */
import { partsInZone } from "../clock.js";
import type { Item } from "../schema.js";
import { verifyDraft, type VerifyResult } from "../pipeline/verify.js";

export interface Draft {
  id: "brief" | "standard" | "events-first";
  name: string;
  subject: string;
  markdown: string;
  html: string;
  item_ids: string[];
  verification: VerifyResult;
}

export interface DraftOptions {
  timeZone: string;
  /** Optional closing line, e.g. an AI-assisted disclosure decided by Volta. */
  footer?: string;
}

const T = {
  title: "This week at Volta",
  events: "Upcoming events",
  news: "In the news",
  linkedin: "From Volta on LinkedIn",
  members: "From our members",
  openUpdate: "Read the update",
  ceo: "From the CEO",
  none: (section: string) => `No ${section.toLowerCase()} items this week.`,
  eventPage: "Event page",
  readMore: "Read more",
  viewPost: "View post",
  alsoOn: "Also covered",
  when: "When",
  where: "Where",
  intro: "Here is what is happening at Volta and around our community.",
  brief: "Brief",
  standard: "Standard",
  eventsFirst: "Events first",
  subjectPrefix: "Volta this week",
};

/** Every fixed phrase the templates can emit, for the verifier allowlist. */
export const TEMPLATE_PHRASES: string[] = [
  T.title, T.events, T.news, T.linkedin, T.members, T.openUpdate, T.ceo, T.eventPage, T.readMore, T.viewPost, T.alsoOn, T.when, T.where, T.intro,
  T.brief, T.standard, T.eventsFirst, T.subjectPrefix, "Volta", "LinkedIn", "Halifax",
  ...["upcoming events", "in the news", "from volta on linkedin", "from our members", "from the ceo"].map((s) => T.none(s)),
  // A held founder update says so in its title; the label is the pipeline's, not the source's.
  "MARKED FOR REVIEW",
];

type Block =
  | { kind: "h1" | "h2" | "p"; text: string }
  | { kind: "item"; title: string; meta: string[]; summary: string; links: { label: string; href: string }[] };

export function buildDrafts(items: Item[], opts: DraftOptions): Draft[] {
  const groups = groupItems(items);
  const layouts: Array<{ id: Draft["id"]; name: string; blocks: Block[] }> = [
    { id: "brief", name: T.brief, blocks: briefBlocks(groups, opts) },
    { id: "standard", name: T.standard, blocks: standardBlocks(groups, opts) },
    { id: "events-first", name: T.eventsFirst, blocks: eventsFirstBlocks(groups, opts) },
  ];
  const subject = subjectLine(items);
  return layouts.map(({ id, name, blocks }) => {
    const all: Block[] = [{ kind: "h1", text: subject }, ...blocks];
    if (opts.footer) all.push({ kind: "p", text: opts.footer });
    const markdown = renderMarkdown(all);
    const allow = [...TEMPLATE_PHRASES, ...(opts.footer ? [opts.footer] : [])];
    const verification = verifyDraft(markdown, items, { timeZone: opts.timeZone, allow });
    return { id, name, subject, markdown, html: renderHtml(all, subject), item_ids: items.map((i) => i.id), verification };
  });
}

interface Groups { events: Item[]; news: Item[]; linkedin: Item[]; members: Item[]; ceo: Item[] }

function groupItems(items: Item[]): Groups {
  const g: Groups = { events: [], news: [], linkedin: [], members: [], ceo: [] };
  for (const it of items) {
    if (it.type === "event") g.events.push(it);
    else if (it.type === "news") g.news.push(it);
    else if (it.type === "ceo_update") g.ceo.push(it);
    else if (it.type === "member_social") g.members.push(it); // members' own updates are not Volta's LinkedIn
    else g.linkedin.push(it);
  }
  g.events.sort((a, b) => a.date.localeCompare(b.date));
  for (const k of ["news", "linkedin", "members", "ceo"] as const) g[k].sort((a, b) => b.date.localeCompare(a.date));
  return g;
}

function subjectLine(items: Item[]): string {
  const top = items[0];
  return top ? `${T.subjectPrefix}: ${top.title}` : T.subjectPrefix;
}

function section(title: string, list: Item[], render: (it: Item) => Block): Block[] {
  const blocks: Block[] = [{ kind: "h2", text: title }];
  if (list.length === 0) blocks.push({ kind: "p", text: T.none(title) });
  else for (const it of list) blocks.push(render(it));
  return blocks;
}

function briefBlocks(g: Groups, o: DraftOptions): Block[] {
  const line = (it: Item): Block => ({ kind: "item", title: it.title, meta: it.type === "event" ? [whenLine(it, o.timeZone)] : [], summary: "", links: [...primaryLink(it), ...relatedLinks(it)] });
  return [...section(T.events, g.events, line), ...section(T.news, g.news, line), ...section(T.linkedin, g.linkedin, line), ...(g.members.length ? section(T.members, g.members, line) : []), ...(g.ceo.length ? section(T.ceo, g.ceo, line) : [])];
}

function standardBlocks(g: Groups, o: DraftOptions): Block[] {
  return [
    { kind: "p", text: T.intro },
    ...section(T.events, g.events, (it) => fullItem(it, o)),
    ...section(T.news, g.news, (it) => fullItem(it, o)),
    ...section(T.linkedin, g.linkedin, (it) => fullItem(it, o)),
    ...(g.members.length ? section(T.members, g.members, (it) => fullItem(it, o)) : []),
    ...(g.ceo.length ? section(T.ceo, g.ceo, (it) => fullItem(it, o)) : []),
  ];
}

function eventsFirstBlocks(g: Groups, o: DraftOptions): Block[] {
  const rest = [...g.news, ...g.linkedin, ...g.members, ...g.ceo].sort((a, b) => b.date.localeCompare(a.date));
  return [
    ...section(T.events, g.events, (it) => fullItem(it, o)),
    ...section(T.news, rest, (it) => fullItem(it, o)),
  ];
}

function fullItem(it: Item, o: DraftOptions): Block {
  const meta: string[] = [];
  if (it.type === "event") {
    meta.push(`${T.when}: ${whenLine(it, o.timeZone)}`);
    if (it.location) meta.push(`${T.where}: ${it.location}`);
  }
  return { kind: "item", title: it.title, meta, summary: it.summary, links: [...primaryLink(it), ...relatedLinks(it)] };
}

function primaryLink(it: Item): { label: string; href: string }[] {
  const label = it.type === "event" ? T.eventPage : it.type === "news" ? T.readMore : it.type === "member_social" ? T.openUpdate : T.viewPost;
  return [{ label, href: it.link }];
}

function relatedLinks(it: Item): { label: string; href: string }[] {
  return (it.related ?? []).map((r) => ({ label: `${T.alsoOn}: ${r.title}`, href: r.link }));
}

const WEEKDAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "Thursday, September 24, 12:00 pm". Full names only, so the verifier can recognize them. */
export function whenLine(it: Item, timeZone: string): string {
  const p = partsInZone(new Date(it.date), timeZone);
  const weekday = WEEKDAY[new Date(it.date).getUTCDay()] ?? "";
  const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  const wd = weekdayInZone(new Date(it.date), timeZone) || weekday;
  return `${wd}, ${MONTH[p.month - 1]} ${p.day}, ${h12}:${String(p.minute).padStart(2, "0")} ${p.hour < 12 ? "am" : "pm"}`;
}

function weekdayInZone(d: Date, timeZone: string): string {
  const w = partsInZone(d, timeZone).weekday;
  return w.charAt(0).toUpperCase() + w.slice(1);
}

export function renderMarkdown(blocks: Block[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.kind === "h1") out.push(`# ${b.text}`, "");
    else if (b.kind === "h2") out.push(`## ${b.text}`, "");
    else if (b.kind === "p") out.push(b.text, "");
    else if (b.kind === "item") {
      out.push(`**${b.title}**`);
      for (const m of b.meta) out.push(`${m}  `);
      if (b.summary) out.push(b.summary);
      out.push(b.links.map((l) => `[${l.label}](${l.href})`).join(" · "), "");
    }
  }
  return out.join("\n").trim() + "\n";
}

export function renderHtml(blocks: Block[], title: string): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.kind === "h1") parts.push(`<h1>${esc(b.text)}</h1>`);
    else if (b.kind === "h2") parts.push(`<h2>${esc(b.text)}</h2>`);
    else if (b.kind === "p") parts.push(`<p>${esc(b.text)}</p>`);
    else if (b.kind === "item") {
      const meta = b.meta.map((m) => `<p class="meta">${esc(m)}</p>`).join("");
      const summary = b.summary ? `<p>${esc(b.summary)}</p>` : "";
      const links = b.links.map((l) => `<a href="${esc(l.href)}">${esc(l.label)}</a>`).join(" · ");
      parts.push(`<article><h3>${esc(b.title)}</h3>${meta}${summary}<p>${links}</p></article>`);
    }
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>` +
    `<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:2rem auto;padding:0 1rem;line-height:1.5;color:#1a1a1a;background:#fff}` +
    `h1{font-size:1.6rem}h2{font-size:1.2rem;margin-top:2rem;border-bottom:1px solid #ccc}h3{font-size:1.05rem;margin:1.2rem 0 .2rem}` +
    `.meta{margin:0;color:#444}a{color:#0b5cad;text-decoration:underline}a:focus{outline:3px solid #0b5cad;outline-offset:2px}</style></head><body><main>${parts.join("\n")}</main></body></html>\n`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
