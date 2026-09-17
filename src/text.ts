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
/**
 * Split text into sentences by finding boundaries, never by matching sentences. A boundary is
 * end punctuation, any closing quotes, whitespace, then something that starts a sentence. Every
 * character of the input lands in exactly one sentence, so nothing can be lost.
 *
 * The earlier approach matched `[^.!?]+[.!?]+` and dropped whatever did not fit. "Closed a $1.4M
 * seed" lost everything before the decimal point and came out as "4M seed": a wrong figure, in a
 * system whose whole promise is not to print wrong figures.
 */
export function splitSentences(text: string): string[] {
  const clean = collapseWhitespace(text);
  if (!clean) return [];
  const out: string[] = [];
  const boundary = /[.!?]+["”’')\]]*\s+(?=["“‘'([]*[A-Z0-9])/g;
  let start = 0;
  for (let m = boundary.exec(clean); m !== null; m = boundary.exec(clean)) {
    const end = m.index + m[0].length;
    out.push(clean.slice(start, end).trim());
    start = end;
  }
  const tail = clean.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

export function firstSentences(text: string, n: number, maxChars: number): string {
  const sentences = splitSentences(text);
  if (sentences.length === 0) return "";
  let out = sentences.slice(0, n).join(" ").trim();
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
