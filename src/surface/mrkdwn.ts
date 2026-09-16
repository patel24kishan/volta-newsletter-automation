/**
 * Convert the templates' Markdown subset to Slack mrkdwn and split it into section-sized chunks.
 * Slack: bold is *text*, links are <url|label>, headings do not exist, sections cap at 3000 chars.
 */
export const SECTION_LIMIT = 2900;

export function markdownToMrkdwn(md: string): string {
  return md
    .split("\n")
    .map((line) => {
      let l = line.replace(/\s{2,}$/, "");
      if (/^# /.test(l)) return `*${escapeMrkdwn(l.slice(2))}*`;
      if (/^## /.test(l)) return `\n*${escapeMrkdwn(l.slice(3))}*`;
      l = l.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, label: string, url: string) => `<${url}|${escapeMrkdwn(label)}>`);
      l = l.replace(/\*\*([^*]+)\*\*/g, "*$1*");
      return l;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Escape the three characters Slack treats specially, without touching links we generate ourselves. */
export function escapeMrkdwn(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Split on blank lines so no chunk exceeds the section limit; a single oversized paragraph is hard-cut. */
export function chunkMrkdwn(text: string, limit = SECTION_LIMIT): string[] {
  const out: string[] = [];
  let cur = "";
  for (const para of text.split(/\n\n+/)) {
    const piece = para.length > limit ? para.slice(0, limit - 1) + "…" : para;
    if (cur && (cur + "\n\n" + piece).length > limit) {
      out.push(cur);
      cur = piece;
    } else {
      cur = cur ? `${cur}\n\n${piece}` : piece;
    }
  }
  if (cur) out.push(cur);
  return out;
}
