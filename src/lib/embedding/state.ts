// Pure-function state machine for Memory.embedding_status transitions.
// All embedding state updates in the cycle must go through this function;
// direct SQL UPDATEs of embedding_status are not allowed.

import type { EmbeddingStatus, ErrorKind } from "./config.js";
import { TRANSIENT_RETRY_MAX, STALE_COUNT_MAX } from "./config.js";

export type StateEvent =
  | { type: "submit_ok"; batchId: string }
  | { type: "fetch_success"; embedding: string; dim: number; model: string }
  | { type: "fetch_transient"; errorReason: string }
  | { type: "fetch_permanent"; errorReason: string }
  | { type: "stale_reclaim" }
  | { type: "content_updated" };

export type SideEffects = {
  embedding_status: EmbeddingStatus;
  embedding_batch_id?: string | null;
  /** Unix epoch seconds; propagated by the cycle caller. */
  embedding_state_changed_at: number;
  embedding_error_kind?: ErrorKind | null;
  embedding_error_reason?: string | null;
  embedding_transient_retry_count?: number;
  embedding_stale_count?: number;
  embedding?: string | null;
  embedding_dim?: number | null;
  embedding_model?: string | null;
};

export type CurrentState = {
  status: EmbeddingStatus;
  transientRetryCount: number;
  staleCount: number;
};

export type TransitionResult =
  | { ok: true; next: EmbeddingStatus; sideEffects: SideEffects }
  | { ok: false; error: string };

export function transitionState(
  current: CurrentState,
  event: StateEvent,
  nowSec: number,
): TransitionResult {
  const { status, transientRetryCount, staleCount } = current;

  // --- pending transitions ---
  if (status === "pending" && event.type === "submit_ok") {
    return {
      ok: true,
      next: "in_progress",
      sideEffects: {
        embedding_status: "in_progress",
        embedding_batch_id: event.batchId,
        embedding_state_changed_at: nowSec,
        embedding_error_kind: null,
        embedding_error_reason: null,
      },
    };
  }

  // --- in_progress transitions ---
  if (status === "in_progress" && event.type === "fetch_success") {
    return {
      ok: true,
      next: "done",
      sideEffects: {
        embedding_status: "done",
        embedding: event.embedding,
        embedding_dim: event.dim,
        embedding_model: event.model,
        embedding_batch_id: null,
        embedding_transient_retry_count: 0,
        embedding_stale_count: 0,
        embedding_error_kind: null,
        embedding_error_reason: null,
        embedding_state_changed_at: nowSec,
      },
    };
  }

  if (status === "in_progress" && event.type === "fetch_transient") {
    // Counts 0..TRANSIENT_RETRY_MAX-2 revert to pending; the last attempt promotes to error.
    if (transientRetryCount < TRANSIENT_RETRY_MAX - 1) {
      return {
        ok: true,
        next: "pending",
        sideEffects: {
          embedding_status: "pending",
          embedding_batch_id: null,
          embedding_state_changed_at: nowSec,
          embedding_transient_retry_count: transientRetryCount + 1,
          embedding_error_kind: null,
          embedding_error_reason: null,
        },
      };
    }
    return {
      ok: true,
      next: "error",
      sideEffects: {
        embedding_status: "error",
        embedding_batch_id: null,
        embedding_state_changed_at: nowSec,
        embedding_error_kind: "transient",
        embedding_error_reason: event.errorReason,
      },
    };
  }

  if (status === "in_progress" && event.type === "fetch_permanent") {
    return {
      ok: true,
      next: "error",
      sideEffects: {
        embedding_status: "error",
        embedding_batch_id: null,
        embedding_state_changed_at: nowSec,
        embedding_error_kind: "permanent",
        embedding_error_reason: event.errorReason,
      },
    };
  }

  if (status === "in_progress" && event.type === "stale_reclaim") {
    // Counts 0..STALE_COUNT_MAX-2 revert to pending; the last attempt promotes to error.
    if (staleCount < STALE_COUNT_MAX - 1) {
      return {
        ok: true,
        next: "pending",
        sideEffects: {
          embedding_status: "pending",
          embedding_batch_id: null,
          embedding_state_changed_at: nowSec,
          embedding_stale_count: staleCount + 1,
        },
      };
    }
    return {
      ok: true,
      next: "error",
      sideEffects: {
        embedding_status: "error",
        embedding_batch_id: null,
        embedding_state_changed_at: nowSec,
        embedding_error_kind: "stale",
        embedding_error_reason: "exceeded stale_count limit",
      },
    };
  }

  // --- done transitions ---
  if (status === "done" && event.type === "content_updated") {
    return {
      ok: true,
      next: "pending",
      sideEffects: {
        embedding_status: "pending",
        embedding_batch_id: null,
        embedding_state_changed_at: nowSec,
        embedding: null,
        embedding_dim: null,
      },
    };
  }

  // --- error transitions ---
  if (status === "error" && event.type === "content_updated") {
    return {
      ok: true,
      next: "pending",
      sideEffects: {
        embedding_status: "pending",
        embedding_batch_id: null,
        embedding_state_changed_at: nowSec,
        embedding_error_kind: null,
        embedding_error_reason: null,
        embedding_transient_retry_count: 0,
      },
    };
  }

  return {
    ok: false,
    error: `IllegalStateTransition: ${status} + ${event.type}`,
  };
}
