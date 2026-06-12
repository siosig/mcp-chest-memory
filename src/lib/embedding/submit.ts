// Submits pending memories to the Gemini Batch API.
// Phase A (in transaction): atomically claims pending rows, creates a provisional
//   EmbeddingBatch record, and marks the memories as in_progress.
// Phase B (outside transaction): calls gemini.submit(texts) — remote I/O.
// On success: updates EmbeddingBatch with the returned job name and status='submitted'.
// On failure: reverts memories to pending and marks EmbeddingBatch as failed in a separate
//   transaction, then re-throws the error.
import type { PrismaClient } from "@prisma/client";
import { rawAll, rawRun } from "../db/prisma-client.js";
import {
  ApiError,
  type GeminiBatchClient,
} from "./gemini-client.js";
import type { Logger, Clock } from "./ports.js";

export interface RunSubmitPhaseOpts {
  prisma: PrismaClient;
  gemini: GeminiBatchClient;
  logger: Logger;
  clock: Clock;
  cycleId: string;
  batchSize: number;
}

export interface RunSubmitPhaseResult {
  submittedCount: number;
  batchId?: string;
}

interface PendingRow {
  id: number;
  content: string;
}

// Lightweight pseudo-ULID for temporary batch IDs; collision safety is provided by
// the cycle ID prefix combined with Math.random().
function tmpUlid(): string {
  return (
    "tmp-" +
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2, 12)
  );
}

export async function runSubmitPhase(
  opts: RunSubmitPhaseOpts,
): Promise<RunSubmitPhaseResult> {
  const { prisma, gemini, logger, clock, cycleId, batchSize } = opts;
  const tmpId = tmpUlid();
  const nowSec = clock.nowSec();

  // ----- Phase A: claim pending rows, create provisional batch, mark memories in_progress -----
  // The captured rows (texts + IDs, oldest-first) are passed to gemini.submit outside the tx.
  const captured: PendingRow[] = await prisma.$transaction(
    async (tx) => {
      // Provisional batch row first; counts are filled in after the claim.
      await rawRun(
        tx,
        `INSERT INTO embedding_batches
           (id, status, record_count, total_input_bytes, cycle_run_id, submitted_at, created_at, updated_at)
         VALUES (?, 'submitting', 0, 0, ?, ?, ?, ?)`,
        tmpId,
        cycleId,
        nowSec,
        nowSec,
        nowSec,
      );

      // Atomic claim: the pending-row subselect is evaluated inside the same
      // UPDATE statement, so a concurrent cycle (even from another process)
      // can never claim the same rows — it sees them as in_progress already.
      const rows = await rawAll<PendingRow & { created_at: number }>(
        tx,
        `UPDATE memories
           SET embedding_status='in_progress',
               embedding_batch_id=?,
               embedding_state_changed_at=?,
               embedding_error_kind=NULL,
               embedding_error_reason=NULL
         WHERE id IN (
           SELECT id FROM memories
            WHERE embedding_status='pending' AND archived_at IS NULL
            ORDER BY created_at ASC, id ASC
            LIMIT ?)
         RETURNING id, content, created_at`,
        tmpId,
        nowSec,
        batchSize,
      );
      if (rows.length === 0) {
        await rawRun(tx, "DELETE FROM embedding_batches WHERE id=?", tmpId);
        return [];
      }

      // RETURNING does not guarantee ordering; restore oldest-first.
      rows.sort((a, b) => a.created_at - b.created_at || a.id - b.id);

      const totalBytes = rows.reduce(
        (acc, r) => acc + Buffer.byteLength(r.content, "utf8"),
        0,
      );
      await rawRun(
        tx,
        "UPDATE embedding_batches SET record_count=?, total_input_bytes=? WHERE id=?",
        rows.length,
        totalBytes,
        tmpId,
      );

      return rows.map(({ id, content }) => ({ id, content }));
    },
    { timeout: 30_000, maxWait: 10_000 },
  );

  if (captured.length === 0) {
    return { submittedCount: 0 };
  }

  // ----- Phase B: call gemini.submit outside the transaction (remote I/O) -----
  let jobName: string;
  try {
    const r = await gemini.submit(captured.map((c) => c.content));
    jobName = r.jobName;
  } catch (e) {
    // On failure: revert memories to pending and mark the batch as failed in a separate tx.
    await prisma.$transaction(async (tx) => {
      const placeholders = captured.map(() => "?").join(",");
      const params: unknown[] = [clock.nowSec(), ...captured.map((c) => c.id)];
      await rawRun(
        tx,
        `UPDATE memories
           SET embedding_status='pending',
               embedding_batch_id=NULL,
               embedding_state_changed_at=?
         WHERE id IN (${placeholders})`,
        ...params,
      );
      const errReason = e instanceof Error ? e.message : String(e);
      await rawRun(
        tx,
        `UPDATE embedding_batches
           SET status='failed', error_summary=?, completed_at=?, updated_at=?
         WHERE id=?`,
        errReason.slice(0, 4000),
        clock.nowSec(),
        clock.nowSec(),
        tmpId,
      );
    });
    if (e instanceof ApiError) {
      logger.warn(
        { kind: e.kind, status: e.httpStatus, msg: e.message },
        "submit ApiError, memories reverted to pending",
      );
    } else {
      logger.error({ err: e }, "submit unexpected error");
    }
    throw e;
  }

  // ----- Phase C: update status to 'submitted' and store the Gemini job name -----
  // EmbeddingBatch.id (PK) remains tmpId to preserve FK integrity with
  // memories.embedding_batch_id and avoid a circular update. The Gemini job name
  // is stored in external_request_id; fetch.ts uses that column when calling gemini.fetch.
  await rawRun(
    prisma,
    `UPDATE embedding_batches
       SET status='submitted', external_request_id=?, updated_at=?
     WHERE id=?`,
    jobName,
    clock.nowSec(),
    tmpId,
  );

  logger.debug?.(
    {
      cycle_id: cycleId,
      batch_id: tmpId,
      job_name: jobName,
      count: captured.length,
    },
    "submit phase complete",
  );

  // The returned batchId is the internal PK (tmpId), matching memories.embedding_batch_id.
  // The Gemini job name is accessed separately via external_request_id during fetch.
  return { submittedCount: captured.length, batchId: tmpId };
}
