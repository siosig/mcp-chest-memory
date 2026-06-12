// Pure-function tests covering all paths through transitionState
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { transitionState } from "../../../src/lib/embedding/state.js";
import {
  TRANSIENT_RETRY_MAX,
  STALE_COUNT_MAX,
} from "../../../src/lib/embedding/config.js";

const NOW = 1_700_000_000;

describe("transitionState — allowed transitions", () => {
  it("pending + submit_ok → in_progress", () => {
    const r = transitionState(
      { status: "pending", transientRetryCount: 0, staleCount: 0 },
      { type: "submit_ok", batchId: "batches/x" },
      NOW,
    );
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.next, "in_progress");
    assert.equal(r.sideEffects.embedding_status, "in_progress");
    assert.equal(r.sideEffects.embedding_batch_id, "batches/x");
    assert.equal(r.sideEffects.embedding_state_changed_at, NOW);
    assert.equal(r.sideEffects.embedding_error_kind, null);
    assert.equal(r.sideEffects.embedding_error_reason, null);
  });

  it("in_progress + fetch_success → done (all fields set)", () => {
    const r = transitionState(
      { status: "in_progress", transientRetryCount: 2, staleCount: 1 },
      {
        type: "fetch_success",
        embedding: "[0.1,0.2]",
        dim: 768,
        model: "gemini-embedding-001",
      },
      NOW,
    );
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.next, "done");
    assert.equal(r.sideEffects.embedding_status, "done");
    assert.equal(r.sideEffects.embedding, "[0.1,0.2]");
    assert.equal(r.sideEffects.embedding_dim, 768);
    assert.equal(r.sideEffects.embedding_model, "gemini-embedding-001");
    assert.equal(r.sideEffects.embedding_batch_id, null);
    assert.equal(r.sideEffects.embedding_transient_retry_count, 0);
    assert.equal(r.sideEffects.embedding_stale_count, 0);
    assert.equal(r.sideEffects.embedding_error_kind, null);
    assert.equal(r.sideEffects.embedding_error_reason, null);
    assert.equal(r.sideEffects.embedding_state_changed_at, NOW);
  });

  it("in_progress + fetch_transient (count 0) → pending, count=1", () => {
    const r = transitionState(
      { status: "in_progress", transientRetryCount: 0, staleCount: 0 },
      { type: "fetch_transient", errorReason: "429 rate limit" },
      NOW,
    );
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.next, "pending");
    assert.equal(r.sideEffects.embedding_transient_retry_count, 1);
    assert.equal(r.sideEffects.embedding_batch_id, null);
    assert.equal(r.sideEffects.embedding_error_kind, null);
  });

  it("in_progress + fetch_transient (count 3) → pending, count=4 (still retriable)", () => {
    const r = transitionState(
      { status: "in_progress", transientRetryCount: 3, staleCount: 0 },
      { type: "fetch_transient", errorReason: "503" },
      NOW,
    );
    assert.equal(r.ok, true);
    if (!r.ok) return;
    // TRANSIENT_RETRY_MAX=5, count 3 < 5-1=4 → pending continue
    assert.equal(r.next, "pending");
    assert.equal(r.sideEffects.embedding_transient_retry_count, 4);
  });

  it(`in_progress + fetch_transient (count ${TRANSIENT_RETRY_MAX - 1}) → error (transient)`, () => {
    const r = transitionState(
      {
        status: "in_progress",
        transientRetryCount: TRANSIENT_RETRY_MAX - 1,
        staleCount: 0,
      },
      { type: "fetch_transient", errorReason: "rate limit exhausted" },
      NOW,
    );
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.next, "error");
    assert.equal(r.sideEffects.embedding_error_kind, "transient");
    assert.equal(r.sideEffects.embedding_error_reason, "rate limit exhausted");
    assert.equal(r.sideEffects.embedding_batch_id, null);
  });

  it("in_progress + fetch_permanent → error (permanent)", () => {
    const r = transitionState(
      { status: "in_progress", transientRetryCount: 0, staleCount: 0 },
      { type: "fetch_permanent", errorReason: "400 invalid input" },
      NOW,
    );
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.next, "error");
    assert.equal(r.sideEffects.embedding_error_kind, "permanent");
    assert.equal(r.sideEffects.embedding_error_reason, "400 invalid input");
  });

  it("in_progress + stale_reclaim (count 0) → pending, count=1", () => {
    const r = transitionState(
      { status: "in_progress", transientRetryCount: 0, staleCount: 0 },
      { type: "stale_reclaim" },
      NOW,
    );
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.next, "pending");
    assert.equal(r.sideEffects.embedding_stale_count, 1);
    assert.equal(r.sideEffects.embedding_batch_id, null);
  });

  it("in_progress + stale_reclaim (count 1) → pending, count=2 (still within limit)", () => {
    const r = transitionState(
      { status: "in_progress", transientRetryCount: 0, staleCount: 1 },
      { type: "stale_reclaim" },
      NOW,
    );
    assert.equal(r.ok, true);
    if (!r.ok) return;
    // STALE_COUNT_MAX=3, count 1 < 3-1=2 → pending continue
    assert.equal(r.next, "pending");
    assert.equal(r.sideEffects.embedding_stale_count, 2);
  });

  it(`in_progress + stale_reclaim (count ${STALE_COUNT_MAX - 1}) → error (stale)`, () => {
    const r = transitionState(
      {
        status: "in_progress",
        transientRetryCount: 0,
        staleCount: STALE_COUNT_MAX - 1,
      },
      { type: "stale_reclaim" },
      NOW,
    );
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.next, "error");
    assert.equal(r.sideEffects.embedding_error_kind, "stale");
    assert.equal(
      r.sideEffects.embedding_error_reason,
      "exceeded stale_count limit",
    );
  });

  it("done + content_updated → pending (embedding=null, dim=null)", () => {
    const r = transitionState(
      { status: "done", transientRetryCount: 0, staleCount: 0 },
      { type: "content_updated" },
      NOW,
    );
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.next, "pending");
    assert.equal(r.sideEffects.embedding, null);
    assert.equal(r.sideEffects.embedding_dim, null);
    assert.equal(r.sideEffects.embedding_batch_id, null);
  });

  it("error + content_updated → pending (error fields cleared)", () => {
    const r = transitionState(
      { status: "error", transientRetryCount: 4, staleCount: 0 },
      { type: "content_updated" },
      NOW,
    );
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.next, "pending");
    assert.equal(r.sideEffects.embedding_error_kind, null);
    assert.equal(r.sideEffects.embedding_error_reason, null);
    assert.equal(r.sideEffects.embedding_transient_retry_count, 0);
  });
});

describe("transitionState — rejected transitions", () => {
  it("pending + fetch_success → IllegalStateTransition", () => {
    const r = transitionState(
      { status: "pending", transientRetryCount: 0, staleCount: 0 },
      {
        type: "fetch_success",
        embedding: "[]",
        dim: 768,
        model: "x",
      },
      NOW,
    );
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /IllegalStateTransition/);
    assert.match(r.error, /pending/);
    assert.match(r.error, /fetch_success/);
  });

  it("done + submit_ok → IllegalStateTransition", () => {
    const r = transitionState(
      { status: "done", transientRetryCount: 0, staleCount: 0 },
      { type: "submit_ok", batchId: "batches/y" },
      NOW,
    );
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /IllegalStateTransition: done \+ submit_ok/);
  });

  it("error + fetch_success → IllegalStateTransition", () => {
    const r = transitionState(
      { status: "error", transientRetryCount: 0, staleCount: 0 },
      {
        type: "fetch_success",
        embedding: "[]",
        dim: 768,
        model: "x",
      },
      NOW,
    );
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /IllegalStateTransition: error \+ fetch_success/);
  });

  it("pending + stale_reclaim → IllegalStateTransition", () => {
    const r = transitionState(
      { status: "pending", transientRetryCount: 0, staleCount: 0 },
      { type: "stale_reclaim" },
      NOW,
    );
    assert.equal(r.ok, false);
  });
});
