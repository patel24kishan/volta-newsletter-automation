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
  insights: "Key insights",
  withPerson: "With",
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
  T.title, T.events, T.news, T.linkedin, T.insights, T.withPerson, T.ceo, T.eventPage, T.readMore, T.viewPost, T.alsoOn, T.when, T.where, T.intro,
  T.brief, T.standard, T.eventsFirst, T.subjectPrefix, "Volta", "LinkedIn", "Halifax",
  ...["upcoming events", "in the news", "from volta on linkedin", "key insights", "from the ceo"].map((s) => T.none(s)),
  // Deliberately absent: "MARKED FOR REVIEW". It is the curator's label and lives only in Slack,
  // so if it ever reached a draft the verifier would reject it rather than wave it through.
];

type Block =
  | { kind: "h1" | "h2" | "p"; text: string }
  | { kind: "item"; title: string; meta: string[]; summary: string; bullets?: string[]; links: { label: string; href: string }[] };

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

/** Key insights appears only when a member update was selected; the other sections always show. */
function insightsSection(g: Groups, render: (it: Item) => Block): Block[] {
  return g.members.length ? section(T.insights, g.members, render) : [];
}

function briefBlocks(g: Groups, o: DraftOptions): Block[] {
  const line = (it: Item): Block => {
    const block: Block = { kind: "item", title: it.title, meta: it.type === "event" ? [whenLine(it, o.timeZone)] : [], summary: "", links: draftLinks(it) };
    if (it.insights?.length) block.bullets = it.insights.slice(0, 1); // brief: the lead point only
    return block;
  };
  return [...section(T.events, g.events, line), ...insightsSection(g, line), ...section(T.news, g.news, line), ...section(T.linkedin, g.linkedin, line), ...(g.ceo.length ? section(T.ceo, g.ceo, line) : [])];
}

/** Standard leads with the stories: Key insights first, then events, news and LinkedIn. */
function standardBlocks(g: Groups, o: DraftOptions): Block[] {
  return [
    { kind: "p", text: T.intro },
    ...insightsSection(g, (it) => fullItem(it, o)),
    ...section(T.events, g.events, (it) => fullItem(it, o)),
    ...section(T.news, g.news, (it) => fullItem(it, o)),
    ...section(T.linkedin, g.linkedin, (it) => fullItem(it, o)),
    ...(g.ceo.length ? section(T.ceo, g.ceo, (it) => fullItem(it, o)) : []),
  ];
}

/**
 * Events first leads with the calendar. Every section keeps its own accurate heading; an earlier
 * version merged LinkedIn posts and member updates under "In the news", which misstated the source.
 */
function eventsFirstBlocks(g: Groups, o: DraftOptions): Block[] {
  return [
    ...section(T.events, g.events, (it) => fullItem(it, o)),
    ...insightsSection(g, (it) => fullItem(it, o)),
    ...section(T.news, g.news, (it) => fullItem(it, o)),
    ...section(T.linkedin, g.linkedin, (it) => fullItem(it, o)),
    ...(g.ceo.length ? section(T.ceo, g.ceo, (it) => fullItem(it, o)) : []),
  ];
}

function fullItem(it: Item, o: DraftOptions): Block {
  const meta: string[] = [];
  if (it.type === "event") {
    meta.push(`${T.when}: ${whenLine(it, o.timeZone)}`);
    if (it.location) meta.push(`${T.where}: ${it.location}`);
  }
  if (it.byline) meta.push(`${T.withPerson} ${it.byline}`);
  const links = draftLinks(it);
  // An item with insights is summarised by them. Its `summary` is the line shown while choosing,
  // which for a founder update is advice to the editor and must not be printed for readers.
  if (it.insights?.length) return { kind: "item", title: it.title, meta, summary: "", bullets: it.insights, links };
  return { kind: "item", title: it.title, meta, summary: it.summary, links };
}

function primaryLink(it: Item): { label: string; href: string }[] {
  const label = it.type === "event" ? T.eventPage : it.type === "news" ? T.readMore : T.viewPost;
  return [{ label, href: it.link }];
}

/**
 * A member update's own link and its related links point into Volta's private Slack workspace:
 * useful for Bader while choosing (the candidate list still shows it), meaningless to a subscriber
 * who cannot open it. The newsletter itself carries no link for these entries.
 */
function draftLinks(it: Item): { label: string; href: string }[] {
  return it.type === "member_social" ? [] : [...primaryLink(it), ...relatedLinks(it)];
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
      for (const point of b.bullets ?? []) out.push(`- ${point}`);
      if (b.bullets?.length) out.push("");
      if (b.links.length) out.push(b.links.map((l) => `[${l.label}](${l.href})`).join(" · "), "");
      else out.push("");
    }
  }
  return out.join("\n").trim() + "\n";
}

/** Mailchimp merge tags the email frame needs. A "code your own" campaign must carry the unsubscribe and address tags. */
export const MERGE_TAGS = {
  address: "*|LIST:ADDRESSLINE|*",
  unsub: "*|UNSUB|*",
  profile: "*|UPDATE_PROFILE|*",
  archive: "*|ARCHIVE|*",
} as const;

/**
 * Words that exist only in the HTML email frame, never in the Markdown the verifier reads. They are
 * fixed text, so they cannot carry an invented fact; the test suite checks that the HTML says
 * nothing else beyond the blocks themselves.
 */
export const HTML_CHROME: string[] = [
  T.intro,
  "Volta",
  "You're getting this because you signed up at Volta.",
  "Unsubscribe",
  "Update your preferences",
  "View in browser",
];

const C = { ink: "#111820", body: "#3F4956", muted: "#5A6472", rule: "#E2E6EA", accent: "#1B3FE0", page: "#EDEFF2" };
const SANS = "Helvetica,Arial,sans-serif";
const SERIF = "Georgia,'Times New Roman',serif";
const HEAD_CSS =
  "body{margin:0;padding:0;width:100% !important;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}" +
  "table{border-collapse:collapse}" +
  `a{color:${C.accent}}` +
  "@media only screen and (max-width:620px){.wrap{width:100% !important}.pad{padding-left:24px !important;padding-right:24px !important}.h1{font-size:26px !important;line-height:32px !important}}";

/**
 * Email-safe HTML for Mailchimp: a 600px table layout with every critical style inline, an Outlook
 * (MSO) block, a hidden preheader, and the unsubscribe/address footer Mailchimp requires. It renders
 * the same blocks as the Markdown, so it adds no words beyond HTML_CHROME.
 */
export function renderHtml(blocks: Block[], title: string): string {
  const rows = blocks.map(htmlRow).join("\n");
  const preheader = `${esc(T.intro)}${"&#847;&zwnj;&nbsp;".repeat(9)}`;
  return [
    `<!DOCTYPE html>`,
    `<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">`,
    `<head>`,
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<meta name="x-apple-disable-message-reformatting">`,
    `<meta name="color-scheme" content="light">`,
    `<meta name="supported-color-schemes" content="light">`,
    `<title>${esc(title)}</title>`,
    `<!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->`,
    `<style>${HEAD_CSS}</style>`,
    `</head>`,
    `<body style="margin:0;padding:0;background-color:${C.page};">`,
    `<div style="display:none;font-size:1px;color:${C.page};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${preheader}</div>`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${C.page};"><tr><td align="center" style="padding:24px 12px;">`,
    `<table role="presentation" class="wrap" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background-color:#FFFFFF;">`,
    `<tr><td class="pad" style="padding:28px 40px 20px 40px;border-bottom:1px solid ${C.rule};font-family:${SERIF};font-size:22px;font-weight:bold;color:${C.ink};">Volta</td></tr>`,
    rows,
    htmlFooter(),
    `</table>`,
    `</td></tr></table>`,
    `</body>`,
    `</html>`,
    ``,
  ].join("\n");
}

function htmlRow(b: Block): string {
  if (b.kind !== "item") return htmlTextRow(b.kind, b.text);
  const meta = b.meta.map((m) => `<div style="font-size:14px;line-height:22px;color:${C.muted};">${esc(m)}</div>`).join("");
  const summary = b.summary ? `<div style="margin-top:6px;color:${C.body};">${esc(b.summary)}</div>` : "";
  const bullets = b.bullets?.length
    ? `<ul style="margin:8px 0 0 0;padding-left:20px;color:${C.body};">${b.bullets.map((p) => `<li style="margin-bottom:6px;">${esc(p)}</li>`).join("")}</ul>`
    : "";
  const links = b.links.length
    ? `<div style="margin-top:8px;font-size:14px;line-height:22px;">${b.links.map((l) => `<a href="${esc(l.href)}" style="color:${C.accent};text-decoration:underline;">${esc(l.label)}</a>`).join(" · ")}</div>`
    : "";
  return `<tr><td class="pad" style="padding:16px 40px 4px 40px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>` +
    `<td style="padding-left:16px;border-left:3px solid ${C.rule};font-family:${SANS};font-size:16px;line-height:24px;color:${C.ink};">` +
    `<strong>${esc(b.title)}</strong>${meta}${summary}${bullets}${links}</td></tr></table></td></tr>`;
}

function htmlTextRow(kind: "h1" | "h2" | "p", text: string): string {
  if (kind === "h1") {
    return `<tr><td class="pad" style="padding:40px;background-color:${C.ink};"><h1 class="h1" style="margin:0;font-family:${SERIF};font-size:30px;line-height:38px;font-weight:normal;color:#FFFFFF;">${esc(text)}</h1></td></tr>`;
  }
  if (kind === "h2") {
    return `<tr><td class="pad" style="padding:32px 40px 8px 40px;"><h2 style="margin:0 0 4px 0;font-family:${SERIF};font-size:20px;font-weight:normal;color:${C.ink};">${esc(text)}</h2>` +
      `<div style="width:40px;height:2px;background-color:${C.accent};font-size:0;line-height:0;">&nbsp;</div></td></tr>`;
  }
  return `<tr><td class="pad" style="padding:12px 40px 4px 40px;font-family:${SANS};font-size:16px;line-height:24px;color:${C.body};">${esc(text)}</td></tr>`;
}

function htmlFooter(): string {
  const link = (tag: string, label: string) => `<a href="${tag}" style="color:#7C8798;text-decoration:underline;">${label}</a>`;
  return `<tr><td class="pad" style="padding:32px 40px;background-color:${C.ink};font-family:${SANS};font-size:12px;line-height:20px;color:#C6CEDA;">` +
    `You're getting this because you signed up at Volta.<br>${MERGE_TAGS.address}<br>` +
    `${link(MERGE_TAGS.unsub, "Unsubscribe")} &nbsp;|&nbsp; ${link(MERGE_TAGS.profile, "Update your preferences")} &nbsp;|&nbsp; ${link(MERGE_TAGS.archive, "View in browser")}` +
    `</td></tr>`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
