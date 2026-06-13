// T028: Reranker fail-open integration test.
// Verifies that when the reranker is enabled but times out or throws,
// the original RRF-ranked result order is preserved (fail-open).
import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

import { rerank, resetRerankerForTest } from "../../src/lib/search/reranker.js";
import type { RerankCandidate } from "../../src/lib/search/reranker.js";

describe("reranker fail-open behavior", () => {
  before(() => {
    process.env.CHEST_RERANK_ENABLED = "true";
    process.env.CHEST_RERANK_TIMEOUT_MS = "5000";
    process.env.CHEST_RERANK_MODEL = "onnx-community/bge-reranker-v2-m3-ONNX";
    resetRerankerForTest();
  });

  after(() => {
    process.env.CHEST_RERANK_ENABLED = "false";
    process.env.CHEST_RERANK_TIMEOUT_MS = "5000";
    resetRerankerForTest();
  });

  beforeEach(() => {
    resetRerankerForTest();
  });

  it("returns original list unchanged when CHEST_RERANK_ENABLED=false", async () => {
    process.env.CHEST_RERANK_ENABLED = "false";
    resetRerankerForTest();

    const candidates: RerankCandidate[] = [
      { id: 1, content: "embedding model selection" },
      { id: 2, content: "FTS tokenizer Japanese" },
      { id: 3, content: "prisma migration schema" },
    ];
    const result = await rerank("embedding model", candidates);
    assert.deepStrictEqual(
      result.map((c) => c.id),
      [1, 2, 3],
      "original order must be preserved when disabled",
    );
  });

  it("returns original list when model fails to load (fail-open on load error)", async () => {
    process.env.CHEST_RERANK_ENABLED = "true";
    process.env.CHEST_RERANK_MODEL = "nonexistent/fake-reranker-model-xyz";
    resetRerankerForTest();

    const candidates: RerankCandidate[] = [
      { id: 10, content: "alpha content" },
      { id: 20, content: "beta content" },
    ];
    // The model doesn't exist; rerank should fail-open and return original list.
    const result = await rerank("alpha", candidates);
    assert.ok(Array.isArray(result), "result must be an array");
    assert.deepStrictEqual(
      result.map((c) => c.id),
      [10, 20],
      "fail-open: original order preserved on model load failure",
    );
  });

  it("returns empty list unchanged", async () => {
    process.env.CHEST_RERANK_ENABLED = "true";
    const result = await rerank("any query", []);
    assert.deepStrictEqual(result, [], "empty input returns empty output");
  });

  it("rerank is a no-op when CHEST_RERANK_ENABLED=false regardless of query", async () => {
    process.env.CHEST_RERANK_ENABLED = "false";
    resetRerankerForTest();

    const candidates: RerankCandidate[] = [
      { id: 100, content: "first" },
      { id: 200, content: "second" },
    ];
    const r1 = await rerank("first", candidates);
    const r2 = await rerank("second", candidates);
    assert.strictEqual(r1, candidates, "should return exact same reference when disabled");
    assert.strictEqual(r2, candidates, "should return exact same reference when disabled");
  });
});
