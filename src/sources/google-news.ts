/**
 * Builds a Google News RSS search URL from plain search terms, so the config holds words the
 * maintainer can read and edit rather than a hand-encoded URL.
 *
 * Terms are OR'd. A multi-word term is wrapped in parentheses, which Google reads as "all of
 * these words", not as an adjacent phrase. That distinction matters: measured against the live
 * feed, `(Volta Halifax)` returns 49 stories where the quoted `"Volta Halifax"` returns 3.
 *
 * To demand an exact phrase, put the quotes in the term yourself and it is passed through
 * untouched, e.g. `"Volta Labs"`.
 */
export interface GoogleNewsOptions {
  /** Interface language, default en-CA. */
  hl?: string;
  /** Country edition, default CA. */
  gl?: string;
}

export function googleNewsUrl(terms: string[], opts: GoogleNewsOptions = {}): string {
  const cleaned = terms.map((t) => t.trim()).filter((t) => t !== "");
  if (cleaned.length === 0) throw new Error("google_news source needs at least one search term");
  const query = cleaned.map(groupTerm).join(" OR ");
  const hl = opts.hl ?? "en-CA";
  const gl = opts.gl ?? "CA";
  const params = new URLSearchParams({ q: query, hl, gl, ceid: `${gl}:${hl.split("-")[0]}` });
  return `https://news.google.com/rss/search?${params.toString()}`;
}

/** A term the maintainer quoted stays exact; a multi-word term becomes an AND group. */
function groupTerm(term: string): string {
  if (term.includes('"')) return term;
  if (term.startsWith("(") && term.endsWith(")")) return term;
  return /\s/.test(term) ? `(${term})` : term;
}
