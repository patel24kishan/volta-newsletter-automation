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

/** Case-insensitive: does the text mention any watchlist term? Empty watchlist matches everything. */
export function mentionsAny(text: string, terms: string[]): boolean {
  if (terms.length === 0) return true;
  const hay = text.toLowerCase();
  return terms.some((t) => t.trim() !== "" && hay.includes(t.toLowerCase()));
}
