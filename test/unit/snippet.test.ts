// Unit tests for snippet extraction.
// Snippet semantics and code-point-based windowing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractSnippet } from "../../src/lib/search/snippet.js";
import { selectWithinTokenBudget } from "../../src/lib/token-budget.js";

/** Returns true if the string contains a lone surrogate (broken UTF-16). */
function hasLoneSurrogate(s: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
}

const cpLen = (s: string): number => Array.from(s).length;

// ---------------------------------------------------------------------------
// Query-term centred window
// ---------------------------------------------------------------------------

test("query term near centre: window centred on term with ellipsis on both sides", () => {
  const content = "a".repeat(500) + " TARGET " + "b".repeat(500);
  const snip = extractSnippet(content, ["TARGET"], 100);
  assert.ok(snip.includes("TARGET"), "snippet must include query term");
  assert.ok(snip.startsWith("…"), "leading ellipsis added on truncation");
  assert.ok(snip.endsWith("…"), "trailing ellipsis added on truncation");
  // body excluding the 2 ellipsis chars equals the window code points
  assert.equal(cpLen(snip) - 2, 100);
});

test("multiple query terms: the first occurrence in content wins", () => {
  const content = "x".repeat(200) + " FIRST " + "y".repeat(200) + " SECOND " + "z".repeat(200);
  const snip = extractSnippet(content, ["SECOND", "FIRST"], 80);
  assert.ok(snip.includes("FIRST"), "the term that appears first in content is centred");
  assert.ok(!snip.includes("SECOND"));
});

test("case-insensitive match (consistent with FTS behaviour)", () => {
  const content = "p".repeat(300) + " chest " + "q".repeat(300);
  const snip = extractSnippet(content, ["Chest"], 60);
  assert.ok(snip.includes("chest"));
});

// ---------------------------------------------------------------------------
// Term absent → fall back to leading window (vector-only hit)
// ---------------------------------------------------------------------------

test("query term absent: returns leading window with trailing ellipsis", () => {
  const content = "c".repeat(1000);
  const snip = extractSnippet(content, ["absent"], 120);
  assert.ok(!snip.startsWith("…"), "no leading ellipsis because snippet starts at beginning");
  assert.ok(snip.endsWith("…"));
  assert.equal(cpLen(snip) - 1, 120);
  assert.equal(snip.slice(0, 120), content.slice(0, 120));
});

test("empty query term array: gracefully returns leading window", () => {
  const content = "d".repeat(500);
  const snip = extractSnippet(content, [], 100);
  assert.equal(cpLen(snip) - 1, 100);
  assert.ok(snip.endsWith("…"));
});

// ---------------------------------------------------------------------------
// Natural clamping at edges (no ellipsis when within bounds)
// ---------------------------------------------------------------------------

test("term near start: clamps start to 0, no leading ellipsis, full window used", () => {
  const content = "TARGET " + "e".repeat(1000);
  const snip = extractSnippet(content, ["TARGET"], 100);
  assert.ok(snip.startsWith("TARGET"), "no leading ellipsis");
  assert.ok(snip.endsWith("…"));
  assert.equal(cpLen(snip) - 1, 100, "full window used after clamping");
});

test("term near end: clamps end to content length, no trailing ellipsis, full window used", () => {
  const content = "f".repeat(1000) + " TARGET";
  const snip = extractSnippet(content, ["TARGET"], 100);
  assert.ok(snip.startsWith("…"));
  assert.ok(snip.endsWith("TARGET"), "no trailing ellipsis");
  assert.equal(cpLen(snip) - 1, 100);
});

test("content shorter than window: returns full text without truncation or ellipsis", () => {
  const content = "短い本文 with TARGET";
  assert.equal(extractSnippet(content, ["TARGET"], 240), content);
  assert.equal(extractSnippet(content, ["absent"], 240), content);
});

// ---------------------------------------------------------------------------
// Code-point boundary safety
// ---------------------------------------------------------------------------

test("surrogate pairs (emoji) are not split", () => {
  // 😀 = U+1F600 (2 code units in UTF-16). A code-unit slice would always break this.
  const content = "😀".repeat(400) + "TARGET" + "😀".repeat(400);
  const snip = extractSnippet(content, ["TARGET"], 101); // odd window to stress boundary alignment
  assert.ok(!hasLoneSurrogate(snip), "no lone surrogates in output");
  assert.ok(snip.includes("TARGET"));
  assert.equal(cpLen(snip) - 2, 101, "window is measured in code points");
});

test("Japanese content: window is measured in code points", () => {
  const content = "あ".repeat(300) + "目印" + "い".repeat(300);
  const snip = extractSnippet(content, ["目印"], 100);
  assert.ok(snip.includes("目印"));
  assert.equal(cpLen(snip) - 2, 100);
  assert.ok(!hasLoneSurrogate(snip));
});

test("leading snippet (term absent) does not split surrogate pairs", () => {
  const content = "𠮷".repeat(500); // U+20BB7 — a surrogate-pair CJK character
  const snip = extractSnippet(content, ["absent"], 99);
  assert.ok(!hasLoneSurrogate(snip));
  assert.equal(cpLen(snip) - 1, 99);
});

// ---------------------------------------------------------------------------
// snippet_mode yields at least 2× more results than full-text mode on the same token budget
// (fixture simulation using selectWithinTokenBudget)
// ---------------------------------------------------------------------------

test("snippet_mode returns at least 2× more results than full-text mode within the same token budget", () => {
  // 50 memories each > 1KB. Query term placed in the middle.
  const fixtures = Array.from({ length: 50 }, (_, i) => ({
    id: i + 1,
    content: "x".repeat(600) + ` keyword-${i} ` + "y".repeat(600), // > 1200 chars ≈ 1.2KB
  }));
  const opts = { maxTokens: 2000, limit: 200, offset: 0 };

  const full = selectWithinTokenBudget(fixtures, (m) => JSON.stringify(m), opts);
  const snippet = selectWithinTokenBudget(
    fixtures,
    (m) => JSON.stringify({ ...m, content: extractSnippet(m.content, ["keyword"], 240) }),
    opts,
  );

  assert.ok(
    snippet.selected.length >= full.selected.length * 2,
    `snippet=${snippet.selected.length} < full=${full.selected.length} × 2`,
  );
});
