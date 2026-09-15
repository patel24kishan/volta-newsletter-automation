/** Small text helpers shared by fetchers and the summarizer. No dependencies. */

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", "#x27": "'", "#160": " ",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    const key = code.toLowerCase();
    if (key in ENTITIES) return ENTITIES[key] as string;
    if (key.startsWith("#x")) return String.fromCodePoint(parseInt(key.slice(2), 16));
    if (key.startsWith("#")) return String.fromCodePoint(parseInt(key.slice(1), 10));
    return m;
  });
}

export function stripHtml(html: string): string {
  return collapseWhitespace(decodeEntities(html.replace(/<br\s*\/?>/gi, " ").replace(/<\/(p|div|li|h\d)>/gi, " ").replace(/<[^>]+>/g, "")));
}

export function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Extractive summary: the first N sentences of a text, cut to maxChars at a word boundary.
 * Returns "" when there is no usable text, so callers can flag needs_summary.
 */
export function firstSentences(text: string, n: number, maxChars: number): string {
  const clean = collapseWhitespace(text);
  if (!clean) return "";
  const sentences = clean.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) ?? [clean];
  let out = sentences.slice(0, n).join("").trim();
  if (out.length > maxChars) {
    out = out.slice(0, maxChars);
    const cut = out.lastIndexOf(" ");
    out = (cut > maxChars / 2 ? out.slice(0, cut) : out).replace(/[,;:\s]+$/, "") + "…";
  }
  return out;
}

/** Case-insensitive: does the text mention any watchlist term? Empty watchlist matches everything. */
export function mentionsAny(text: string, terms: string[]): boolean {
  if (terms.length === 0) return true;
  const hay = text.toLowerCase();
  return terms.some((t) => t.trim() !== "" && hay.includes(t.toLowerCase()));
}
