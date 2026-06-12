// Snippet extraction for recall snippet mode. Pure function — no DB or I/O dependencies.
// Truncates at Unicode code point boundaries (not UTF-16 code units) so that
// surrogate pairs (emoji, supplementary CJK characters, etc.) are never split.

export const DEFAULT_SNIPPET_WINDOW = 240;

/**
 * Extract a window of `windowCodePoints` code points centered on the first occurrence
 * of any query term in the content (case-insensitive).
 * - For multiple terms, the earliest occurrence in the content is used.
 * - When no term is found (e.g. vector-only hit), the window starts from the beginning.
 * - `…` is appended/prepended at truncation points; clamped ends use the full window without `…`.
 * - If content fits within the window, it is returned unchanged
 *   (return value === content indicates no truncation occurred).
 */
export function extractSnippet(
  content: string,
  queryTerms: string[],
  windowCodePoints: number = DEFAULT_SNIPPET_WINDOW,
): string {
  const window = Math.max(1, Math.floor(windowCodePoints));
  const cps = Array.from(content);
  if (cps.length <= window) return content;

  // Find the earliest-occurring term (UTF-16 index, later converted to code point index)
  const lower = content.toLowerCase();
  let matchUtf16 = -1;
  let matchTermLen16 = 0;
  for (const term of queryTerms) {
    if (!term) continue;
    const idx = lower.indexOf(term.toLowerCase());
    if (idx >= 0 && (matchUtf16 < 0 || idx < matchUtf16)) {
      matchUtf16 = idx;
      matchTermLen16 = term.length;
    }
  }

  let start: number;
  if (matchUtf16 >= 0) {
    const matchCp = Array.from(content.slice(0, matchUtf16)).length;
    const termCpLen = Array.from(content.slice(matchUtf16, matchUtf16 + matchTermLen16)).length;
    const center = matchCp + Math.floor(termCpLen / 2);
    start = center - Math.floor(window / 2);
  } else {
    start = 0;
  }
  // Clamp to content boundaries; the full window is used when start/end would overflow
  start = Math.max(0, Math.min(start, cps.length - window));
  const end = start + window;

  const prefix = start > 0 ? "…" : "";
  const suffix = end < cps.length ? "…" : "";
  return prefix + cps.slice(start, end).join("") + suffix;
}
