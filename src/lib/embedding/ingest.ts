// Writes Gemini batch results back to memories and triggers supersession outside the transaction.
// - Inside the transaction: fetches memories belonging to the batch (created_at ASC),
//   writes each vector to the JSON column, and marks each memory as done.
// - Outside the transaction: calls evaluateSupersessionFor for each memory id (oldest first).
import type { PrismaClient } from "@prisma/client";
import { rawAll, rawRun } from "../db/prisma-client.js";
import { evaluateSupersessionFor } from "../supersession.js";
import type { Logger, Clock } from "./ports.js";
import { GEMINI_EMBEDDING_DIM as EMBEDDING_DIM, GEMINI_MODEL_ID } from "./config.js";

export interface ApplyBatchResultsOpts {
  prisma: PrismaClient;
  batchId: string;
  vectors: number[][];
  logger: Logger;
  clock: Clock;
}

export interface ApplyBatchResultsResult {
  doneCount: number;
  supersededCount: number;
}

export class VectorCountMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VectorCountMismatchError";
  }
}

interface MemRow {
  id: number;
  created_at: number;
}

export async function applyBatchResults(
  opts: ApplyBatchResultsOpts,
): Promise<ApplyBatchResultsResult> {
  const { prisma, batchId, vectors, logger, clock } = opts;
  const nowSec = clock.nowSec();

  // ----- Bulk UPDATE inside a transaction -----
  const memIds = await prisma.$transaction(
    async (tx) => {
      // Fetch memories belonging to this batch in created_at ASC order
      // (matches the order they were submitted).
      const rows = await rawAll<MemRow>(
        tx,
        `SELECT id, created_at FROM memories
           WHERE embedding_batch_id = ?
           ORDER BY created_at ASC, id ASC`,
        batchId,
      );

      if (rows.length !== vectors.length) {
        // Consistency error: vector count does not match memory count.
        // Roll back the transaction and let the caller (fetch.ts) route to
        // applyFailureToBatch(transient) so memories revert to pending and
        // consume transient_retry_count until the limit triggers an error.
        logger.error(
          { batch_id: batchId, mem_count: rows.length, vec_count: vectors.length },
          "applyBatchResults: vector count mismatch",
        );
        throw new VectorCountMismatchError(
          `vector count mismatch: got ${vectors.length} vs ${rows.length} memories`,
        );
      }

      // Write each vector into the corresponding memory row.
      for (let i = 0; i < rows.length; i++) {
        const vec = vectors[i];
        if (vec.length !== EMBEDDING_DIM) {
          // Dimension mismatch — mark only this memory as a permanent error.
          await rawRun(
            tx,
            `UPDATE memories
               SET embedding_status='error',
                   embedding_batch_id=NULL,
                   embedding_state_changed_at=?,
                   embedding_error_kind='permanent',
                   embedding_error_reason=?
             WHERE id=?`,
            nowSec,
            `dim mismatch: got ${vec.length}`,
            rows[i].id,
          );
          continue;
        }
        await rawRun(
          tx,
          `UPDATE memories
             SET embedding=?,
                 embedding_dim=?,
                 embedding_model=?,
                 embedding_status='done',
                 embedding_transient_retry_count=0,
                 embedding_stale_count=0,
                 embedding_batch_id=NULL,
                 embedding_error_kind=NULL,
                 embedding_error_reason=NULL,
                 embedding_state_changed_at=?
           WHERE id=?`,
          JSON.stringify(vec),
          EMBEDDING_DIM,
          GEMINI_MODEL_ID,
          nowSec,
          rows[i].id,
        );
      }

      // Mark the batch as succeeded.
      await rawRun(
        tx,
        `UPDATE embedding_batches
           SET status='succeeded', completed_at=?, updated_at=?
         WHERE id=?`,
        nowSec,
        nowSec,
        batchId,
      );

      return rows.map((r) => r.id);
    },
    { timeout: 60_000, maxWait: 20_000 },
  );

  // ----- Trigger supersession outside the transaction, oldest-first -----
  let supersededCount = 0;
  for (const mid of memIds) {
    try {
      const r = await evaluateSupersessionFor(mid, {
        prisma,
        logger,
        clock,
      });
      supersededCount += r.supersededCount;
    } catch (e) {
      logger.warn(
        { mid, err: e instanceof Error ? e.message : String(e) },
        "evaluateSupersessionFor failed (continuing)",
      );
    }
  }

  return { doneCount: memIds.length, supersededCount };
}
