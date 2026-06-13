// FTS5 query formatting utilities.
// Two modes:
//   formatFtsQuery(raw)        - trigram-compatible: drops terms <3 chars, OR-joins quoted terms
//   formatFtsQueryFromTokens() - token-based: accepts short terms, OR-joins quoted tokens

/**
 * Build an FTS5 match expression for trigram-indexed content.
 * Filters out terms shorter than 3 code points (trigram minimum).
 * Returns empty string when no valid terms remain.
 */
export function formatFtsQuery(raw: string): string {
  const terms = raw
    .replace(/["]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => Array.from(t).length >= 3);
  return terms.map((t) => `"${t}"`).join(" OR ");
}

/**
 * Build an FTS5 match expression from pre-tokenized terms.
 * Accepts short terms (no 3-char minimum) — suitable for unicode61-indexed content
 * where each token is a morpheme produced by a morphological analyzer.
 * Returns empty string when the token list is empty.
 */
export function formatFtsQueryFromTokens(tokens: string[]): string {
  const filtered = tokens.map((t) => t.trim()).filter((t) => t.length > 0);
  return filtered.map((t) => `"${t.replace(/"/g, " ")}"`).join(" OR ");
}
