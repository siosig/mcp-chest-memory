// Reclaims memories that have been in_progress for longer than STALE_THRESHOLD_SEC.
// Uses transitionState({stale_reclaim}) to decide whether to revert to pending
// or promote to error based on the stale_count boundary.
import type { PrismaClient } from "@prisma/client";
import { rawAll, rawRun } from "../db/prisma-client.js";
import { transitionState } from "./state.js";
import { STALE_THRESHOLD_SEC } from "./config.js";
import type { Logger, Clock } from "./ports.js";

export interface RunReclaimOpts {
  prisma: PrismaClient;
  logger: Logger;
  clock: Clock;
  cycleId: string;
}

export interface RunReclaimResult {
  staleReclaim: number;
  staleErrorAdded: number;
}

interface StaleMem {
  id: number;
  embedding_stale_count: number;
  embedding_transient_retry_count: number;
}

export async function runReclaim(opts: RunReclaimOpts): Promise<RunReclaimResult> {
  const { prisma, clock, logger } = opts;
  const nowSec = clock.nowSec();
  const threshold = nowSec - STALE_THRESHOLD_SEC;

  const rows = await rawAll<StaleMem>(
    prisma,
    `SELECT id, embedding_stale_count, embedding_transient_retry_count
       FROM memories
       WHERE embedding_status='in_progress'
         AND embedding_state_changed_at < ?
       LIMIT 1000`,
    threshold,
  );

  let staleReclaim = 0;
  let staleErrorAdded = 0;

  for (const m of rows) {
    const tr = transitionState(
      {
        status: "in_progress",
        transientRetryCount: m.embedding_transient_retry_count,
        staleCount: m.embedding_stale_count,
      },
      { type: "stale_reclaim" },
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
             embedding_stale_count=COALESCE(?, embedding_stale_count)
       WHERE id=?`,
      se.embedding_status,
      se.embedding_batch_id ?? null,
      se.embedding_state_changed_at,
      se.embedding_error_kind ?? null,
      se.embedding_error_reason ?? null,
      se.embedding_stale_count ?? null,
      m.id,
    );
    if (se.embedding_status === "pending") staleReclaim++;
    else if (se.embedding_status === "error") staleErrorAdded++;
  }

  if (rows.length > 0) {
    logger.info?.(
      { stale_reclaim: staleReclaim, stale_error: staleErrorAdded, candidates: rows.length },
      "reclaim phase complete",
    );
  }

  return { staleReclaim, staleErrorAdded };
}
