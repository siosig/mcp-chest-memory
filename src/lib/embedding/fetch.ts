// Polls Gemini Batch status and applies succeeded / failed / expired results.
// - Selects up to M submitted/running EmbeddingBatches ordered by submitted_at ASC.
// - For each batch, calls gemini.fetch(name):
//   - pending/running  → no-op (or promote submitted→running)
//   - succeeded        → applyBatchResults(batchId, vectors)
//   - failed (transient)  → revert owned memories to pending via transitionState({fetch_transient}),
//                           or promote to error if the retry limit is reached
//   - failed (permanent) / expired / cancelled → set owned memories to error (fetch_permanent)
import type { PrismaClient } from "@prisma/client";
import { rawAll, rawRun } from "../db/prisma-client.js";
import type { GeminiBatchClient } from "./gemini-client.js";
import { applyBatchResults, VectorCountMismatchError } from "./ingest.js";
import { transitionState } from "./state.js";
import type { Logger, Clock } from "./ports.js";

export interface RunFetchPhaseOpts {
  prisma: PrismaClient;
  gemini: GeminiBatchClient;
  logger: Logger;
  clock: Clock;
  maxFetch: number;
}

export interface RunFetchPhaseResult {
  fetchedCount: number;
  doneAdded: number;
  errorAdded: number;
  transientRetried: number;
}

interface BatchRow {
  id: string;
  status: string;
  external_request_id: string | null;
}

interface MemRow {
  id: number;
  embedding_status: string;
  embedding_transient_retry_count: number;
  embedding_stale_count: number;
}

export async function runFetchPhase(
  opts: RunFetchPhaseOpts,
): Promise<RunFetchPhaseResult> {
  const { prisma, gemini, logger, clock, maxFetch } = opts;

  const batches = await rawAll<BatchRow>(
    prisma,
    `SELECT id, status, external_request_id FROM embedding_batches
       WHERE status IN ('submitted','running')
       ORDER BY submitted_at ASC
       LIMIT ?`,
    maxFetch,
  );

  let fetchedCount = 0;
  let doneAdded = 0;
  let errorAdded = 0;
  let transientRetried = 0;

  for (const b of batches) {
    fetchedCount++;
    if (!b.external_request_id) {
      logger.warn({ batch_id: b.id }, "fetch: batch lacks external_request_id, skipping");
      continue;
    }
    let result;
    try {
      result = await gemini.fetch(b.external_request_id);
    } catch (e) {
      logger.warn(
        { batch_id: b.id, err: e instanceof Error ? e.message : String(e) },
        "fetch threw, skipping",
      );
      continue;
    }

    switch (result.state) {
      case "pending":
      case "running": {
        // Promote submitted → running if the remote state has advanced.
        if (b.status === "submitted" && result.state === "running") {
          await rawRun(
            prisma,
            `UPDATE embedding_batches SET status='running', updated_at=? WHERE id=?`,
            clock.nowSec(),
            b.id,
          );
        }
        break;
      }
      case "succeeded": {
        try {
          const r = await applyBatchResults({
            prisma,
            batchId: b.id,
            vectors: result.vectors,
            logger,
            clock,
          });
          doneAdded += r.doneCount;
        } catch (e) {
          if (e instanceof VectorCountMismatchError) {
            // Vector count mismatch indicates a Gemini-side or parse anomaly.
            // Treat as transient: revert owned memories to pending and mark the batch failed.
            const reason = e.message;
            const r = await applyFailureToBatch(
              prisma,
              clock,
              b.id,
              "transient",
              reason,
            );
            transientRetried += r.pendingReverted;
            errorAdded += r.errorAdded;
            await rawRun(
              prisma,
              `UPDATE embedding_batches SET status='failed', error_summary=?, completed_at=?, updated_at=? WHERE id=?`,
              reason.slice(0, 4000),
              clock.nowSec(),
              clock.nowSec(),
              b.id,
            );
          } else {
            throw e;
          }
        }
        break;
      }
      case "failed": {
        // May be transient (retryable) or permanent.
        const errKind = result.errorKind;
        const reason = result.errorReason;
        const r = await applyFailureToBatch(
          prisma,
          clock,
          b.id,
          errKind,
          reason,
        );
        if (errKind === "transient") {
          transientRetried += r.pendingReverted;
          errorAdded += r.errorAdded;
        } else {
          errorAdded += r.errorAdded;
        }
        await rawRun(
          prisma,
          `UPDATE embedding_batches SET status='failed', error_summary=?, completed_at=?, updated_at=? WHERE id=?`,
          reason.slice(0, 4000),
          clock.nowSec(),
          clock.nowSec(),
          b.id,
        );
        break;
      }
      case "expired":
      case "cancelled": {
        const r = await applyFailureToBatch(
          prisma,
          clock,
          b.id,
          "permanent",
          result.errorReason,
        );
        errorAdded += r.errorAdded;
        await rawRun(
          prisma,
          `UPDATE embedding_batches SET status=?, error_summary=?, completed_at=?, updated_at=? WHERE id=?`,
          result.state === "expired" ? "expired" : "failed",
          result.errorReason.slice(0, 4000),
          clock.nowSec(),
          clock.nowSec(),
          b.id,
        );
        break;
      }
    }
  }

  return { fetchedCount, doneAdded, errorAdded, transientRetried };
}

async function applyFailureToBatch(
  prisma: PrismaClient,
  clock: Clock,
  batchId: string,
  errKind: "transient" | "permanent",
  reason: string,
): Promise<{ pendingReverted: number; errorAdded: number }> {
  // Fetch in_progress memories belonging to this batch.
  const mems = await rawAll<MemRow>(
    prisma,
    `SELECT id, embedding_status, embedding_transient_retry_count, embedding_stale_count
       FROM memories WHERE embedding_batch_id = ?`,
    batchId,
  );
  let pendingReverted = 0;
  let errorAdded = 0;
  const nowSec = clock.nowSec();

  for (const m of mems) {
    if (m.embedding_status !== "in_progress") continue; // skip safety
    const tr = transitionState(
      {
        status: "in_progress",
        transientRetryCount: m.embedding_transient_retry_count,
        staleCount: m.embedding_stale_count,
      },
      errKind === "transient"
        ? { type: "fetch_transient", errorReason: reason }
        : { type: "fetch_permanent", errorReason: reason },
      nowSec,
    );
    if (!tr.ok) continue;
    const se = tr.sideEffects;
    await rawRun(
      prisma,
      `UPDATE memories
         SET embedding_status=?,
             embedding_batch_id=?,
             embedding_state_changed_at=?,
             embedding_error_kind=?,
             embedding_error_reason=?,
             embedding_transient_retry_count=COALESCE(?, embedding_transient_retry_count)
       WHERE id=?`,
      se.embedding_status,
      se.embedding_batch_id ?? null,
      se.embedding_state_changed_at,
      se.embedding_error_kind ?? null,
      se.embedding_error_reason ?? null,
      se.embedding_transient_retry_count ?? null,
      m.id,
    );
    if (se.embedding_status === "pending") pendingReverted++;
    else if (se.embedding_status === "error") errorAdded++;
  }

  return { pendingReverted, errorAdded };
}
