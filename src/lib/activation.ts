// ACT-R Base-Level Activation for decay-aware retrieval.
//
// Heavy computation lives here and is invoked ONLY by `chest-index up --activation`.
// The MCP recall path never calls these — it reads the persisted
// `activation_score` / `ttl_penalty` / `supersession_penalty` columns.
//
// Parameters are tunable; the integration test uses well-separated
// fixtures so ranking order is robust to exact tuning.

import { prisma, rawAll, rawRun } from "./db/prisma-client.js";

export const ACTR_DECAY_D = 0.5; // power-law decay exponent (ACT-R standard)
export const ACTR_TAU = -6.0; // logistic center for 0..1 normalization (tunable)
export const ACTR_NOISE_S = 1.5; // logistic scale (tunable)
export const ACCESS_LOG_WINDOW = 50; // rolling window size
const ACTIVATION_STALE_SECS = 600; // 10 min staleness for incremental batch
const PIN_IMPORTANCE = 0.9;

/** ACT-R Base-Level: B = ln( Σ_j max(1, age_j)^(-d) ). Higher = more active. */
export function baseLevelActivation(accessAgesSec: number[], d = ACTR_DECAY_D): number {
  if (accessAgesSec.length === 0) return Number.NEGATIVE_INFINITY;
  let sum = 0;
  for (const age of accessAgesSec) sum += Math.pow(Math.max(1, age), -d);
  return Math.log(sum);
}

/** Normalize Base-Level B to a 0..1 retrieval-probability shape (logistic). */
export function normalizeActivation(B: number, tau = ACTR_TAU, s = ACTR_NOISE_S): number {
  if (!Number.isFinite(B)) return 0;
  return 1 / (1 + Math.exp(-(B - tau) / s));
}

// Layer-default TTL (days). null = no expiry. User can override via remember(expires_at).
export const LAYER_TTL_DAYS: Record<string, number | null> = {
  goal: null,
  realize: null,
  learning: 365,
  implementation: 90,
  context: 30,
  emotion: 14,
};

/** Resolve the default expiry (unixepoch sec) for a layer, or null for no expiry. */
export function defaultExpiresAt(layer: string, createdAtSec: number): number | null {
  const days = LAYER_TTL_DAYS[layer];
  return days == null ? null : createdAtSec + days * 86400;
}

/** TTL penalty: 1.0 while unexpired; exponential decay after expiry (floor 0.05). */
export function computeTtlPenalty(expiresAt: number | null, nowSec: number): number {
  if (expiresAt == null) return 1.0;
  if (nowSec < expiresAt) return 1.0;
  const overdueDays = (nowSec - expiresAt) / 86400;
  return Math.max(0.05, Math.exp(-overdueDays / 14)); // ~14d decay constant past expiry
}

interface ActivationRow {
  id: number;
  importance: number;
  protected: number;
  layer: string;
  created_at: number;
  expires_at: number | null;
  superseded_by_id: number | null;
}

export interface ActivationResult {
  updated: number;
  prunedAccessLog: number;
  durationMs: number;
}

/**
 * Persist activation_score / ttl_penalty / supersession_penalty for stale or
 * uncomputed memories (or all, with `force`). Pinned / protected / goal memories keep
 * activation_score = 1.0 (never decayed). Prunes the access log to the last N rows.
 */
export async function runActivationPhase(
  opts: { force?: boolean; check?: boolean; now?: number } = {},
): Promise<ActivationResult> {
  const start = Date.now();
  const now = opts.now ?? Math.floor(Date.now() / 1000);

  const where = opts.force
    ? "archived_at IS NULL"
    : "archived_at IS NULL AND (activation_computed_at IS NULL OR activation_computed_at < ?)";
  const params = opts.force ? [] : [now - ACTIVATION_STALE_SECS];
  const targets = await rawAll<ActivationRow>(
    prisma,
    `SELECT id, importance, protected, layer, created_at, expires_at, superseded_by_id
     FROM memories WHERE ${where}`,
    ...params,
  );

  if (opts.check) {
    return { updated: targets.length, prunedAccessLog: 0, durationMs: Date.now() - start };
  }

  // Compute and UPDATE activation for each memory. Batch (cron) processing —
  // per-row autocommit is sufficient.
  for (const m of targets) {
    const isPinned = m.importance >= PIN_IMPORTANCE || m.protected === 1 || m.layer === "goal";
    let activation: number;
    if (isPinned) {
      activation = 1.0; // protected from time decay
    } else {
      const logRows = await rawAll<{ accessed_at: number }>(
        prisma,
        `SELECT accessed_at FROM memory_access_log WHERE memory_id = ? ORDER BY accessed_at DESC LIMIT ${ACCESS_LOG_WINDOW}`,
        m.id,
      );
      const ages =
        logRows.length > 0
          ? logRows.map((r) => now - r.accessed_at)
          : [now - m.created_at]; // pseudo-access at creation if no log yet
      activation = normalizeActivation(baseLevelActivation(ages));
    }
    const ttl = computeTtlPenalty(m.expires_at, now);
    const supersession = m.superseded_by_id != null ? 0.0 : 1.0;
    await rawRun(
      prisma,
      `UPDATE memories
       SET activation_score = ?, ttl_penalty = ?, supersession_penalty = ?, activation_computed_at = ?
       WHERE id = ?`,
      activation,
      ttl,
      supersession,
      now,
      m.id,
    );
  }

  // Prune the access log to the last N rows per memory (rolling window).
  // The subquery alias `AS ranked` is required; the DELETE references it via a
  // derived table to avoid the "can't specify target table for update" restriction.
  const pruned = await rawRun(
    prisma,
    `DELETE FROM memory_access_log
     WHERE id IN (
       SELECT id FROM (
         SELECT id, ROW_NUMBER() OVER (PARTITION BY memory_id ORDER BY accessed_at DESC) AS rn
         FROM memory_access_log
       ) AS ranked WHERE rn > ${ACCESS_LOG_WINDOW}
     )`,
  );

  await rawRun(
    prisma,
    "INSERT INTO events (kind, payload) VALUES ('activation_batch_completed', ?)",
    JSON.stringify({ updated: targets.length, pruned_access_log: pruned, duration_ms: Date.now() - start }),
  );

  return { updated: targets.length, prunedAccessLog: pruned, durationMs: Date.now() - start };
}
