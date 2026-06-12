// Local auto-supersession sweep.
// The embed function is no longer called at runtime (the embedding cycle handles that);
// this module simply reads already-persisted vectors from the database and performs
// a cosine comparison in JS. The `embed` argument is kept for signature compatibility
// (the CLI passes a no-op embedder).
//
// Guards applied to reduce false positives:
// - (a) SUPERSEDE_THRESHOLD = 0.97 (near-duplicates only).
// - (b) Same-layer constraint + skip when both contents are JSON with identical top-level key sets.
// - (c) Per-entity peer scan bounded by a time window and row cap to prevent O(n²) work.
//
// These guards apply to the `chest-index up --supersess` batch only; the MCP layer is unchanged.

import { prisma, rawAll, rawGet, rawRun, type RawClient } from "./db/prisma-client.js";
import { activeProvider } from "./embedding/provider.js";
import type { Logger, Clock } from "./embedding/ports.js";

export type EmbedFn = (texts: string[]) => Promise<number[][]>;

// Near-duplicate cosine threshold. Values above this indicate the new memory
// supersedes the old one. Both e5-small and Gemini embedding-001 show similar
// cosine distributions for unrelated (~0.74) and related (~0.88+) content,
// so 0.97 is chosen to target only near-exact duplicates.
export const SUPERSEDE_THRESHOLD = 0.97;

// Per-entity peer scan limits.
// 90 days covers the typical decision-update horizon; 200 rows caps latency
// per sweep across large entity sets.
export const SUPERSESS_TIME_WINDOW_SEC = 90 * 86_400;
export const SUPERSESS_PEER_LIMIT = 200;

// Batch size for the embed function injection path.
// After the unified timer integration the CLI passes a no-op embedder, so this
// loop body never executes in production. The parameter is kept for tests that
// inject a real embedder.
const EMBED_BATCH = 16;

/**
 * FR-313 (realize #4534-b): if a JSON content's top-level key set matches another
 * JSON's, both are "instances of the same shape" — almost certainly distinct
 * facts (file-edit logs, periodic snapshots) rather than an overwrite. Returns
 * the sorted key signature, or `null` for non-object content (plain text / arrays).
 */
export function structuralShapeKey(content: string): string | null {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const keys = Object.keys(parsed as Record<string, unknown>);
  if (keys.length === 0) return null;
  return keys.slice().sort().join("|");
}

/** Cosine similarity. Vectors from embedding.ts are unit-normalized, but compute fully for safety. */
export function cosineSim(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Mark `oldId` as superseded by `newId` (archive transition + supersession columns +
 * event). Idempotent (`WHERE archived_at IS NULL`). Used by both the auto batch and
 * the manual `remember(supersedes:[...])` path. Returns true if newly superseded.
 */
export async function supersede(
  oldId: number,
  newId: number,
  confidence: number | null,
  method: "auto" | "manual",
  nowSec?: number,
  client: RawClient = prisma,
): Promise<boolean> {
  const now = nowSec ?? Math.floor(Date.now() / 1000);
  const changes = await rawRun(
    client,
    "UPDATE memories SET archived_at = ?, superseded_by_id = ?, supersession_confidence = ? WHERE id = ? AND archived_at IS NULL",
    now,
    newId,
    confidence,
    oldId,
  );
  if (changes === 0) return false;
  await rawRun(
    client,
    "INSERT INTO events (entity_id, kind, payload) SELECT entity_id, 'memory_superseded', ? FROM memories WHERE id = ?",
    JSON.stringify({ method, old_id: oldId, new_id: newId, confidence }),
    oldId,
  );
  return true;
}

interface NullRow {
  id: number;
  content: string;
  entity_id: number;
  created_at: number;
  layer: string;
}

interface PeerRow {
  id: number;
  embedding: string;
  content: string;
}

export interface SupersessResult {
  embedded: number;
  compared: number;
  superseded: number;
  /** How many comparisons were rejected before cosine by guard (b): shape match or layer mismatch. Useful for realize #4534 regression. */
  skippedByShape: number;
  durationMs: number;
}

export interface SupersessOptions {
  threshold?: number;
  timeWindowSec?: number;
  peerLimit?: number;
  check?: boolean;
  now?: number;
  /**
   * `embedding_model` value to stamp on freshly embedded rows. Defaults to the
   * active provider's model ID. Set explicitly when called from `runReembedPhase`
   * with a target model different from the current default.
   */
  modelId?: string;
}

/**
 * FR-304: embed memories whose embedding is NULL, then detect supersession against
 * older same-entity active memories (cosine >= threshold). Newer memory wins.
 * Idempotent (FR-310): embedded rows are skipped on re-run; archived rows excluded.
 *
 * Guards (FR-311/312/313/314, realize #4534):
 * - Peers restricted to SAME layer (FR-312).
 * - Peers within `timeWindowSec` only (FR-314, default 90 days).
 * - Up to `peerLimit` newest peers per candidate (FR-314, default 200).
 * - Comparison skipped if both contents are JSON with identical top-level key
 *   sets (FR-313 — "same shape, different fact").
 * - Cosine threshold defaults to 0.97 (FR-311).
 */
export async function runSupersessPhase(
  embed: EmbedFn,
  opts: SupersessOptions = {},
): Promise<SupersessResult> {
  const start = Date.now();
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const threshold = opts.threshold ?? SUPERSEDE_THRESHOLD;
  const timeWindow = opts.timeWindowSec ?? SUPERSESS_TIME_WINDOW_SEC;
  const peerLimit = opts.peerLimit ?? SUPERSESS_PEER_LIMIT;
  const modelId = opts.modelId ?? activeProvider().model;

  // Process oldest-first so that when a newer memory is evaluated, older ones in the
  // same batch are already embedded + active and can be superseded by it.
  const nulls = await rawAll<NullRow>(
    prisma,
    "SELECT id, content, entity_id, created_at, layer FROM memories WHERE embedding IS NULL AND archived_at IS NULL ORDER BY created_at ASC, id ASC",
  );

  if (opts.check) {
    return {
      embedded: nulls.length,
      compared: 0,
      superseded: 0,
      skippedByShape: 0,
      durationMs: Date.now() - start,
    };
  }

  // 1. Embed in chunks and persist. Embedding runs outside the transaction (CPU-bound).
  for (let i = 0; i < nulls.length; i += EMBED_BATCH) {
    const chunk = nulls.slice(i, i + EMBED_BATCH);
    const vecs = await embed(chunk.map((m) => m.content));
    await prisma.$transaction(
      async (tx) => {
        for (let j = 0; j < chunk.length; j++) {
          await rawRun(
            tx,
            "UPDATE memories SET embedding = ?, embedding_model = ? WHERE id = ?",
            JSON.stringify(vecs[j]),
            modelId,
            chunk[j].id,
          );
        }
      },
      { timeout: 60_000, maxWait: 20_000 },
    );
  }

  // 2. detect supersession: each newly embedded memory vs OLDER active embedded
  // peers within the same entity *and* layer, within the time window, capped at
  // peerLimit (FR-304b/c + FR-311/312/313/314).
  let compared = 0;
  let superseded = 0;
  let skippedByShape = 0;

  // Newest peers first: if peerLimit clips, we retain the candidates most likely
  // to be the immediately preceding version (recency matters more than antiquity).
  const peersSql = `SELECT id, embedding, content FROM memories
     WHERE entity_id = ?
       AND layer = ?
       AND archived_at IS NULL
       AND superseded_by_id IS NULL
       AND embedding IS NOT NULL
       AND id != ?
       AND created_at >= ?
       AND (created_at < ? OR (created_at = ? AND id < ?))
     ORDER BY created_at DESC, id DESC
     LIMIT ?`;

  for (const m of nulls) {
    const meRow = await rawGet<{ embedding: string | null }>(
      prisma,
      "SELECT embedding FROM memories WHERE id = ? AND archived_at IS NULL",
      m.id,
    );
    if (!meRow?.embedding) continue; // m itself may have been superseded earlier in this loop
    const myVec = JSON.parse(meRow.embedding) as number[];
    const myShape = structuralShapeKey(m.content);

    const peers = await rawAll<PeerRow>(
      prisma,
      peersSql,
      m.entity_id,
      m.layer,
      m.id,
      m.created_at - timeWindow,
      m.created_at,
      m.created_at,
      m.id,
      peerLimit,
    );

    for (const p of peers) {
      // Same JSON shape means different facts of the same kind (e.g. periodic snapshots).
      // Skip before cosine to keep computation cheap and the metric meaningful.
      if (myShape !== null) {
        const peerShape = structuralShapeKey(p.content);
        if (peerShape !== null && peerShape === myShape) {
          skippedByShape++;
          continue;
        }
      }
      compared++;
      const sim = cosineSim(myVec, JSON.parse(p.embedding) as number[]);
      if (sim >= threshold) {
        if (await supersede(p.id, m.id, sim, "auto", now)) superseded++;
      }
    }
  }

  await rawRun(
    prisma,
    "INSERT INTO events (kind, payload) VALUES ('supersess_batch_completed', ?)",
    JSON.stringify({
      embedded: nulls.length,
      compared,
      superseded,
      skipped_by_shape: skippedByShape,
      threshold,
      time_window_sec: timeWindow,
      peer_limit: peerLimit,
      duration_ms: Date.now() - start,
    }),
  );

  return {
    embedded: nulls.length,
    compared,
    superseded,
    skippedByShape,
    durationMs: Date.now() - start,
  };
}

/**
 * Re-embed memories whose embedding_model differs from the target (model change or
 * dtype change — the dtype is encoded into the recorded model ID). Resets those
 * embeddings to NULL then runs the normal supersession phase.
 */
export async function runReembedPhase(
  embed: EmbedFn,
  opts: { targetModel?: string; check?: boolean; now?: number } = {},
): Promise<SupersessResult & { reembedded: number }> {
  const target = opts.targetModel ?? activeProvider().model;
  const staleRow = await rawGet<{ c: number }>(
    prisma,
    "SELECT COUNT(*) c FROM memories WHERE archived_at IS NULL AND (embedding_model IS NULL OR embedding_model != ?)",
    target,
  );
  const stale = Number(staleRow?.c ?? 0);

  if (opts.check) {
    return {
      reembedded: stale,
      embedded: 0,
      compared: 0,
      superseded: 0,
      skippedByShape: 0,
      durationMs: 0,
    };
  }

  // Reset stale embeddings so the supersess phase recomputes them.
  await rawRun(
    prisma,
    "UPDATE memories SET embedding = NULL WHERE archived_at IS NULL AND (embedding_model IS NULL OR embedding_model != ?)",
    target,
  );

  const r = await runSupersessPhase(embed, { now: opts.now, modelId: target });
  return { reembedded: stale, ...r };
}

/**
 * Evaluate supersession for a single memory. Called from `applyBatchResults` when
 * an embedding batch transitions to done (oldest first).
 *
 * Guards: cosine threshold 0.97 / same layer / identical JSON shape skipped /
 * 90-day time window / max 200 peers. Only peers with the matching embedding_dim
 * are compared to prevent dimension mismatch errors.
 *
 * Does not call `embed()` — both the target memory and its peers are assumed to
 * be in the done state with persisted vectors. Returns {supersededCount: 0}
 * if the target has no embedding.
 */
export interface EvaluateSupersessionForOpts {
  prisma: typeof prisma;
  logger: Logger;
  clock: Clock;
  threshold?: number;
  timeWindowSec?: number;
  peerLimit?: number;
}

export async function evaluateSupersessionFor(
  memoryId: number | bigint,
  opts: EvaluateSupersessionForOpts,
): Promise<{ supersededCount: number }> {
  const id = typeof memoryId === "bigint" ? Number(memoryId) : memoryId;
  const threshold = opts.threshold ?? SUPERSEDE_THRESHOLD;
  const timeWindow = opts.timeWindowSec ?? SUPERSESS_TIME_WINDOW_SEC;
  const peerLimit = opts.peerLimit ?? SUPERSESS_PEER_LIMIT;
  const now = opts.clock.nowSec();

  // Fetch the target memory (active, embedding done, matching provider dim only)
  const me = await rawGet<{
    id: number;
    entity_id: number;
    layer: string;
    content: string;
    created_at: number;
    embedding: string | null;
    embedding_dim: number | null;
  }>(
    opts.prisma,
    "SELECT id, entity_id, layer, content, created_at, embedding, embedding_dim FROM memories WHERE id = ? AND archived_at IS NULL",
    id,
  );
  if (!me || !me.embedding || me.embedding_dim !== activeProvider().dim) {
    return { supersededCount: 0 };
  }

  const myVec = JSON.parse(me.embedding) as number[];
  const myShape = structuralShapeKey(me.content);

  // Peer query: same entity + same layer + active + matching dim + older than target + within time window
  const peers = await rawAll<PeerRow>(
    opts.prisma,
    `SELECT id, embedding, content FROM memories
       WHERE entity_id = ?
         AND layer = ?
         AND archived_at IS NULL
         AND superseded_by_id IS NULL
         AND embedding IS NOT NULL
         AND embedding_dim = ?
         AND id != ?
         AND created_at >= ?
         AND (created_at < ? OR (created_at = ? AND id < ?))
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    me.entity_id,
    me.layer,
    activeProvider().dim,
    me.id,
    me.created_at - timeWindow,
    me.created_at,
    me.created_at,
    me.id,
    peerLimit,
  );

  let supersededCount = 0;
  for (const p of peers) {
    if (myShape !== null) {
      const peerShape = structuralShapeKey(p.content);
      if (peerShape !== null && peerShape === myShape) continue;
    }
    let peerVec: number[];
    try {
      peerVec = JSON.parse(p.embedding) as number[];
    } catch {
      continue;
    }
    const sim = cosineSim(myVec, peerVec);
    if (sim >= threshold) {
      if (await supersede(p.id, me.id, sim, "auto", now)) supersededCount++;
    }
  }

  return { supersededCount };
}
