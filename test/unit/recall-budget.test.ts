// Pure-function tests for selectWithinTokenBudget / estimateTokens (no DB).
// Guards the permanent fix for the bug where output ballooned because token count
// was estimated incorrectly, violating the max_tokens contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  estimateTokens,
  selectWithinTokenBudget,
  TOKENS_PER_CHAR,
} from "../../src/lib/token-budget.js";

// serialize: pass string as-is (estimateTokens computes length × 0.3).
const idStr = (s: string): string => s;

test("estimateTokens = ceil(length * TOKENS_PER_CHAR)", () => {
  assert.equal(TOKENS_PER_CHAR, 0.3);
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("x".repeat(100)), 30); // ceil(30.0)
  assert.equal(estimateTokens("x".repeat(101)), 31); // ceil(30.3)
});

test("stops at budget; total tokens within budget; stoppedBy=tokens", () => {
  const items = Array.from({ length: 10 }, () => "x".repeat(100)); // 30 tokens each
  const r = selectWithinTokenBudget(items, idStr, { maxTokens: 100, limit: 200, offset: 0 });
  assert.equal(r.selected.length, 3); // 30*3=90<=100; 4th item 120>100 stops
  assert.equal(r.usedTokens, 90);
  assert.equal(r.stoppedBy, "tokens");
});

test("even with tiny budget, at least 1 item is returned (2nd item triggers token stop)", () => {
  const items = ["x".repeat(1000), "y".repeat(1000)]; // 300 tokens each
  const r = selectWithinTokenBudget(items, idStr, { maxTokens: 10, limit: 200, offset: 0 });
  assert.equal(r.selected.length, 1);
  assert.equal(r.selected[0], items[0]);
  assert.equal(r.stoppedBy, "tokens");
});

test("stops at limit; stoppedBy=limit", () => {
  const items = Array.from({ length: 10 }, () => "x".repeat(10)); // 3 tokens each
  const r = selectWithinTokenBudget(items, idStr, { maxTokens: 100_000, limit: 2, offset: 0 });
  assert.equal(r.selected.length, 2);
  assert.equal(r.stoppedBy, "limit");
});

test("offset skips leading items", () => {
  const items = ["a", "b", "c", "d", "e"];
  const r = selectWithinTokenBudget(items, idStr, { maxTokens: 100_000, limit: 200, offset: 2 });
  assert.deepEqual(r.selected, ["c", "d", "e"]);
  assert.equal(r.stoppedBy, "end");
});

test("all candidates fit within budget → stoppedBy=end", () => {
  const items = ["a", "b", "c"];
  const r = selectWithinTokenBudget(items, idStr, { maxTokens: 100_000, limit: 200, offset: 0 });
  assert.equal(r.selected.length, 3);
  assert.equal(r.stoppedBy, "end");
});

test("safetyCapTokens takes precedence over maxTokens when smaller (prevents runaway with huge max_tokens)", () => {
  const items = Array.from({ length: 100 }, () => "x".repeat(100)); // 30 tokens each
  const r = selectWithinTokenBudget(items, idStr, {
    maxTokens: 1_000_000,
    limit: 200,
    offset: 0,
    safetyCapTokens: 100,
  });
  assert.equal(r.selected.length, 3); // min(1_000_000, 100)=100 → 3 items
  assert.equal(r.stoppedBy, "tokens");
});

test("empty array → nothing selected; stoppedBy=end", () => {
  const r = selectWithinTokenBudget<string>([], idStr, { maxTokens: 100, limit: 200, offset: 0 });
  assert.equal(r.selected.length, 0);
  assert.equal(r.usedTokens, 0);
  assert.equal(r.stoppedBy, "end");
});

test("offset beyond range → empty result (at-least-1 guarantee applies only when candidates exist)", () => {
  const items = ["a", "b"];
  const r = selectWithinTokenBudget(items, idStr, { maxTokens: 100, limit: 200, offset: 5 });
  assert.equal(r.selected.length, 0);
  assert.equal(r.stoppedBy, "end");
});
