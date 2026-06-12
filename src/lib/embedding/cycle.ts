// Orchestrates one embedding cycle: submit loop × K batches, then fetch, then reclaim.
// Persists a BatchCycleRun record and emits a single JSON summary log line on completion.
import type { PrismaClient } from "@prisma/client";
import { rawAll, rawRun } from "../db/prisma-client.js";
import { runSubmitPhase } from "./submit.js";
import { runFetchPhase } from "./fetch.js";
import { runReclaim } from "./reclaim.js";
import { ApiError, type GeminiBatchClient } from "./gemini-client.js";
import type { Logger, Clock } from "./ports.js";

export interface RunEmbedCycleOpts {
  prisma: PrismaClient;
  gemini: GeminiBatchClient;
  logger: Logger;
  clock: Clock;
  maxSubmit: number;
  maxFetch: number;
  maxSubmitBatches: number;
  cycleId?: string;
  submitOnly?: boolean;
  fetchOnly?: boolean;
}

export interface CycleResult {
  cycleId: string;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  pendingBefore: number;
  inProgressBefore: number;
  submittedBatches: number;
  fetchedBatches: number;
  doneAdded: number;
  errorAdded: number;
  transientRetry: number;
  staleReclaim: number;
  permanentError?: { message: string; httpStatus?: number };
}

function newCycleId(): string {
  return (
    Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 12)
  );
}

async function countByStatus(
  prisma: PrismaClient,
): Promise<{ pending: number; inProgress: number }> {
  const rows = await rawAll<{ s: string; c: number }>(
    prisma,
    "SELECT embedding_status s, COUNT(*) c FROM memories GROUP BY embedding_status",
  );
  let pending = 0;
  let inProgress = 0;
  for (const r of rows) {
    if (r.s === "pending") pending = Number(r.c);
    else if (r.s === "in_progress") inProgress = Number(r.c);
  }
  return { pending, inProgress };
}

export async function runEmbedCycle(opts: RunEmbedCycleOpts): Promise<CycleResult> {
  const { prisma, gemini, logger, clock, maxSubmit, maxFetch, maxSubmitBatches } = opts;
  const cycleId = opts.cycleId ?? newCycleId();
  const startedAt = clock.nowSec();
  const startedMs = Date.now();

  const { pending, inProgress } = await countByStatus(prisma);

  // Create a BatchCycleRun record to track this cycle's progress.
  await rawRun(
    prisma,
    `INSERT INTO batch_cycle_runs
       (id, started_at, pending_count_before, in_progress_count_before)
     VALUES (?, ?, ?, ?)`,
    cycleId,
    startedAt,
    pending,
    inProgress,
  );

  const perBatchSize = Math.max(1, Math.floor(maxSubmit / Math.max(1, maxSubmitBatches)));
  let submittedBatches = 0;
  let fetchedBatches = 0;
  let doneAdded = 0;
  let errorAdded = 0;
  let transientRetry = 0;
  let permanentError: ApiError | undefined;
  const errors: Array<{ kind: string; msg: string }> = [];

  // ----- submit loop -----
  if (!opts.fetchOnly) {
    for (let i = 0; i < maxSubmitBatches; i++) {
      try {
        const r = await runSubmitPhase({
          prisma,
          gemini,
          logger,
          clock,
          cycleId,
          batchSize: perBatchSize,
        });
        if (r.submittedCount === 0) break; // pending queue exhausted
        submittedBatches++;
      } catch (e) {
        if (e instanceof ApiError) {
          if (e.kind === "permanent") {
            permanentError = e;
            errors.push({ kind: "submit_permanent", msg: e.message });
            break;
          }
          // Transient: defer to the next cycle.
          errors.push({ kind: "submit_transient", msg: e.message });
          logger.warn(
            { err: e.message, status: e.httpStatus },
            "submit transient error, skip this cycle",
          );
        } else {
          errors.push({ kind: "submit_unknown", msg: e instanceof Error ? e.message : String(e) });
          logger.error({ err: e }, "submit unknown error");
        }
        break;
      }
    }
  }

  // ----- fetch -----
  if (!permanentError && !opts.submitOnly) {
    try {
      const r = await runFetchPhase({
        prisma,
        gemini,
        logger,
        clock,
        maxFetch,
      });
      fetchedBatches = r.fetchedCount;
      doneAdded = r.doneAdded;
      errorAdded = r.errorAdded;
      transientRetry = r.transientRetried;
    } catch (e) {
      logger.error({ err: e }, "fetch phase error");
      errors.push({ kind: "fetch_unknown", msg: e instanceof Error ? e.message : String(e) });
    }
  }

  // ----- reclaim (always runs) -----
  let staleReclaim = 0;
  try {
    const r = await runReclaim({ prisma, logger, clock, cycleId });
    staleReclaim = r.staleReclaim;
    errorAdded += r.staleErrorAdded;
  } catch (e) {
    logger.error({ err: e }, "reclaim phase error");
    errors.push({ kind: "reclaim_unknown", msg: e instanceof Error ? e.message : String(e) });
  }

  // ----- finalize cycle -----
  const finishedAt = clock.nowSec();
  const durationMs = Date.now() - startedMs;

  await rawRun(
    prisma,
    `UPDATE batch_cycle_runs
       SET finished_at=?,
           submitted_batches=?,
           fetched_batches=?,
           done_added=?,
           error_added=?,
           errors=?
     WHERE id=?`,
    finishedAt,
    submittedBatches,
    fetchedBatches,
    doneAdded,
    errorAdded,
    errors.length > 0 ? JSON.stringify(errors) : null,
    cycleId,
  );

  // ----- Terminal summary log -----
  logger.info(
    {
      cycle_id: cycleId,
      started_at: startedAt,
      finished_at: finishedAt,
      duration_ms: durationMs,
      pending_before: pending,
      in_progress_before: inProgress,
      submitted_batches: submittedBatches,
      fetched_batches: fetchedBatches,
      done_added: doneAdded,
      error_added: errorAdded,
      transient_retry: transientRetry,
      stale_reclaim: staleReclaim,
    },
    "embed-cycle complete",
  );

  const result: CycleResult = {
    cycleId,
    startedAt,
    finishedAt,
    durationMs,
    pendingBefore: pending,
    inProgressBefore: inProgress,
    submittedBatches,
    fetchedBatches,
    doneAdded,
    errorAdded,
    transientRetry,
    staleReclaim,
  };
  if (permanentError) {
    result.permanentError = {
      message: permanentError.message,
      httpStatus: permanentError.httpStatus,
    };
    logger.error(
      { err: permanentError.message, status: permanentError.httpStatus },
      "embed-cycle aborted due to permanent error",
    );
  }

  return result;
}
