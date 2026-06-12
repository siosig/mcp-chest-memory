// Unit tests for recall-scoring: config loader, per-path normalisation, and score integration.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  loadRecallScoringConfig,
  normalizeVectorScores,
  integrateRelevance,
  NEUTRAL_RELEVANCE,
} from "../../src/lib/search/recall-scoring.js";

// ---------------------------------------------------------------------------
// loadRecallScoringConfig
// ---------------------------------------------------------------------------

test("config: all env vars absent → all defaults", () => {
  const c = loadRecallScoringConfig({});
  assert.equal(c.vectorEnabled, true);
  assert.equal(c.embedTimeoutMs, 3000);
  assert.equal(c.wVec, 0.5);
  assert.equal(c.minCos, 0.55);
});

test("config: env overrides are applied", () => {
  const c = loadRecallScoringConfig({
    CHEST_RECALL_VECTOR_ENABLED: "true",
    CHEST_RECALL_EMBED_TIMEOUT_MS: "1500",
    CHEST_RECALL_W_VEC: "0.3",
    CHEST_RECALL_VECTOR_MIN_COS: "0.7",
  });
  assert.equal(c.vectorEnabled, true);
  assert.equal(c.embedTimeoutMs, 1500);
  assert.equal(c.wVec, 0.3);
  assert.equal(c.minCos, 0.7);
});

test("config: kill switch is false only for 'false' / '0' (case-insensitive)", () => {
  assert.equal(loadRecallScoringConfig({ CHEST_RECALL_VECTOR_ENABLED: "false" }).vectorEnabled, false);
  assert.equal(loadRecallScoringConfig({ CHEST_RECALL_VECTOR_ENABLED: "FALSE" }).vectorEnabled, false);
  assert.equal(loadRecallScoringConfig({ CHEST_RECALL_VECTOR_ENABLED: "0" }).vectorEnabled, false);
  // any other string → true (contract: parse rule)
  assert.equal(loadRecallScoringConfig({ CHEST_RECALL_VECTOR_ENABLED: "no" }).vectorEnabled, true);
  assert.equal(loadRecallScoringConfig({ CHEST_RECALL_VECTOR_ENABLED: "" }).vectorEnabled, true);
});

test("config: invalid values (NaN, non-positive) fall back to defaults", () => {
  const c = loadRecallScoringConfig({
    CHEST_RECALL_EMBED_TIMEOUT_MS: "abc",
    CHEST_RECALL_W_VEC: "xyz",
    CHEST_RECALL_VECTOR_MIN_COS: "??",
  });
  assert.equal(c.embedTimeoutMs, 3000);
  assert.equal(c.wVec, 0.5);
  assert.equal(c.minCos, 0.55);
  assert.equal(loadRecallScoringConfig({ CHEST_RECALL_EMBED_TIMEOUT_MS: "0" }).embedTimeoutMs, 3000);
  assert.equal(loadRecallScoringConfig({ CHEST_RECALL_EMBED_TIMEOUT_MS: "-5" }).embedTimeoutMs, 3000);
});

test("config: wVec is clamped to [0,1]; minCos is clamped to [-1,1]", () => {
  assert.equal(loadRecallScoringConfig({ CHEST_RECALL_W_VEC: "1.5" }).wVec, 1);
  assert.equal(loadRecallScoringConfig({ CHEST_RECALL_W_VEC: "-0.2" }).wVec, 0);
  assert.equal(loadRecallScoringConfig({ CHEST_RECALL_VECTOR_MIN_COS: "2" }).minCos, 1);
  assert.equal(loadRecallScoringConfig({ CHEST_RECALL_VECTOR_MIN_COS: "-2" }).minCos, -1);
});

// ---------------------------------------------------------------------------
// normalizeVectorScores
// ---------------------------------------------------------------------------

test("normalize: empty set → empty Map", () => {
  assert.equal(normalizeVectorScores([]).size, 0);
});

test("normalize: single entry → 1.0", () => {
  const m = normalizeVectorScores([{ id: 1, score: 0.62 }]);
  assert.equal(m.get(1), 1.0);
});

test("normalize: all scores equal (span < 1e-6) → all hits 1.0", () => {
  const m = normalizeVectorScores([
    { id: 1, score: 0.7 },
    { id: 2, score: 0.7 },
    { id: 3, score: 0.7 + 1e-9 },
  ]);
  assert.equal(m.get(1), 1.0);
  assert.equal(m.get(2), 1.0);
  assert.equal(m.get(3), 1.0);
});

test("normalize: Min-Max scales to [0,1]; cosine order equals vecNorm order (monotonic)", () => {
  const hits = [
    { id: 1, score: 0.58 },
    { id: 2, score: 0.91 },
    { id: 3, score: 0.74 },
    { id: 4, score: 0.66 },
  ];
  const m = normalizeVectorScores(hits);
  assert.equal(m.get(1), 0); // min
  assert.equal(m.get(2), 1); // max
  // monotonicity: when sorted by score ascending, vecNorm is also ascending
  const sorted = [...hits].sort((a, b) => a.score - b.score);
  for (let i = 1; i < sorted.length; i++) {
    assert.ok(m.get(sorted[i].id)! > m.get(sorted[i - 1].id)!, `monotonic at ${i}`);
  }
  // no NaN; all values in [0,1]
  for (const v of m.values()) {
    assert.ok(!Number.isNaN(v) && v >= 0 && v <= 1);
  }
});

// ---------------------------------------------------------------------------
// integrateRelevance
// ---------------------------------------------------------------------------

test("integrate: both paths → weighted average (default equal weights)", () => {
  assert.ok(Math.abs(integrateRelevance(0.8, 0.4, 0.5) - 0.6) < 1e-12);
  // wVec=0.3 → 0.7*0.8 + 0.3*0.4 = 0.68
  assert.ok(Math.abs(integrateRelevance(0.8, 0.4, 0.3) - 0.68) < 1e-12);
});

test("integrate: single path → value used as-is (no fixed floor)", () => {
  assert.equal(integrateRelevance(0.8, null, 0.5), 0.8);
  assert.equal(integrateRelevance(null, 0.2, 0.5), 0.2); // vector-only is not floored to 0.5
  assert.equal(integrateRelevance(null, 0.95, 0.5), 0.95);
});

test("integrate: both null (LIKE-only) → neutral value 0.5", () => {
  assert.equal(integrateRelevance(null, null, 0.5), NEUTRAL_RELEVANCE);
});

test("integrate: out-of-range wVec is clamped; result stays in [0,1]", () => {
  assert.equal(integrateRelevance(0.8, 0.4, 5), 0.4); // clamp → wVec=1
  assert.equal(integrateRelevance(0.8, 0.4, -5), 0.8); // clamp → wVec=0
  for (const [f, v] of [
    [0, 0],
    [1, 1],
    [0.001, 0.999],
  ] as const) {
    const r = integrateRelevance(f, v, 0.5);
    assert.ok(r >= 0 && r <= 1 && !Number.isNaN(r));
  }
});
