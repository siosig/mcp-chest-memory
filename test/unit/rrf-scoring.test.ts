// Unit tests for RRF (Reciprocal Rank Fusion) scoring.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  rrfScore,
  normalizeRrfScores,
  loadRecallScoringConfig,
  DEFAULT_RRF_K,
} from "../../src/lib/search/recall-scoring.js";

test("rrfScore: computes Σ 1/(k + rank) as expected", () => {
  assert.equal(rrfScore(1, undefined, 60), 1 / 61);
  assert.equal(rrfScore(undefined, 1, 60), 1 / 61);
  assert.equal(rrfScore(2, 3, 60), 1 / 62 + 1 / 63);
});

test("both-path top (fts#2+vec#2) outscores single-path top (fts#1 only)", () => {
  const both = rrfScore(2, 2, DEFAULT_RRF_K);
  const single = rrfScore(1, undefined, DEFAULT_RRF_K);
  assert.ok(both > single, `${both} <= ${single}`);
});

test("any dual-path score beats single-path rank=1, regardless of second rank", () => {
  for (const r of [1, 10, 100, 1000]) {
    assert.ok(rrfScore(1, r) > rrfScore(1, undefined));
  }
});

test("single-path only (vector absent) still preserves FTS rank order gracefully", () => {
  // FTS rank ordering is preserved even when the vector path produces no hits
  const a = rrfScore(1, undefined);
  const b = rrfScore(2, undefined);
  const c = rrfScore(3, undefined);
  assert.ok(a > b && b > c);
});

test("no hits on either path → score 0 (treated as NEUTRAL by caller)", () => {
  assert.equal(rrfScore(undefined, undefined), 0);
});

test("smaller k increases top-rank bias", () => {
  const gapSmallK = rrfScore(1, undefined, 10) - rrfScore(5, undefined, 10);
  const gapLargeK = rrfScore(1, undefined, 600) - rrfScore(5, undefined, 600);
  assert.ok(gapSmallK > gapLargeK);
});

test("rank < 1 or undefined contributes 0 to the sum (defensive guard)", () => {
  assert.equal(rrfScore(0, undefined), 0);
  assert.equal(rrfScore(-1, 1), rrfScore(undefined, 1));
});

// ---------------------------------------------------------------------------
// normalizeRrfScores
// ---------------------------------------------------------------------------

test("normalize: hit rows are Min-Max scaled to 0..1; non-hits (score=0) are excluded", () => {
  const raw = new Map<number, number>([
    [1, rrfScore(1, 1)],
    [2, rrfScore(5, undefined)],
    [3, 0], // like-only
  ]);
  const norm = normalizeRrfScores(raw);
  assert.equal(norm.get(1), 1.0);
  assert.equal(norm.get(2), 0.0);
  assert.equal(norm.has(3), false);
});

test("normalize: single hit or all-equal values → 1.0", () => {
  assert.equal(normalizeRrfScores(new Map([[7, 0.01]])).get(7), 1.0);
  const norm = normalizeRrfScores(new Map([[1, 0.02], [2, 0.02]]));
  assert.equal(norm.get(1), 1.0);
  assert.equal(norm.get(2), 1.0);
});

test("normalize: monotonicity — raw rank order is preserved", () => {
  const raw = new Map<number, number>([
    [1, rrfScore(1, 2)],
    [2, rrfScore(3, 5)],
    [3, rrfScore(10, undefined)],
  ]);
  const norm = normalizeRrfScores(raw);
  assert.ok(norm.get(1)! > norm.get(2)! && norm.get(2)! > norm.get(3)!);
});

// ---------------------------------------------------------------------------
// config: CHEST_RRF_K
// ---------------------------------------------------------------------------

test("config: CHEST_RRF_K defaults to 60, can be overridden, and is clamped", () => {
  assert.equal(loadRecallScoringConfig({}).rrfK, 60);
  assert.equal(loadRecallScoringConfig({ CHEST_RRF_K: "30" }).rrfK, 30);
  assert.equal(loadRecallScoringConfig({ CHEST_RRF_K: "0" }).rrfK, 1);
  assert.equal(loadRecallScoringConfig({ CHEST_RRF_K: "99999" }).rrfK, 1000);
  assert.equal(loadRecallScoringConfig({ CHEST_RRF_K: "abc" }).rrfK, 60);
});
