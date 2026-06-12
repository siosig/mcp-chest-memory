// Synchronous (write-time) embedding for the local provider, plus the
// pending sweep used by `chest-index cycle` in local mode.
//
// Contract: saving a memory NEVER fails because of embedding. If the model is
// unavailable (e.g. offline before the first download) the row simply stays
// in embedding_status='pending' and is picked up later by the sweep.

import { prisma, rawAll, rawRun } from "../db/prisma-client.js";
import { activeProvider } from "./provider.js";
import { logger } from "../../utils/logger.js";

function syncEmbedDisabled(): boolean {
  return process.env.CHEST_SYNC_EMBED === "0";
}

/**
 * Embed one memory's content in-process and mark it done.
 * Returns true when the vector was stored, false when the row stays pending.
 */
export async function embedMemorySync(memoryId: number, content: string): Promise<boolean> {
  if (syncEmbedDisabled()) return false;
  const provider = activeProvider();
  if (provider.id !== "local") {
    // The gemini provider embeds asynchronously through the batch cycle to
    // keep write latency and API cost characteristics unchanged.
    return false;
  }
  try {
    const vectors = await provider.embedPassages([content]);
    const vec = vectors?.[0];
    if (!vec) return false;
    await rawRun(
      prisma,
      `UPDATE memories
         SET embedding=?, embedding_model=?, embedding_dim=?,
             embedding_status='done', embedding_state_changed_at=unixepoch(),
             embedding_error_kind=NULL, embedding_error_reason=NULL
       WHERE id=?`,
      JSON.stringify(vec),
      provider.model,
      provider.dim,
      memoryId,
    );
    return true;
  } catch (e) {
    logger.warn(
      { err: e instanceof Error ? e.message : String(e), memoryId },
      "synchronous embedding failed; row stays pending",
    );
    return false;
  }
}

export interface LocalSweepResult {
  scanned: number;
  embedded: number;
}

/**
 * Backfill pending rows with the local provider (no batch records involved).
 * Used by `chest-index cycle` when CHEST_EMBEDDING_PROVIDER=local, and by
 * `chest-index reembed` after a provider switch.
 */
export async function runLocalPendingSweep(limit = 200): Promise<LocalSweepResult> {
  const provider = activeProvider();
  if (provider.id !== "local") return { scanned: 0, embedded: 0 };

  const rows = await rawAll<{ id: number; content: string }>(
    prisma,
    `SELECT id, content FROM memories
      WHERE embedding_status='pending' AND archived_at IS NULL
      ORDER BY created_at ASC, id ASC
      LIMIT ?`,
    limit,
  );
  if (rows.length === 0) return { scanned: 0, embedded: 0 };

  const vectors = await provider.embedPassages(rows.map((r) => r.content));
  if (!vectors) {
    logger.warn({ scanned: rows.length }, "local sweep: model unavailable, rows stay pending");
    return { scanned: rows.length, embedded: 0 };
  }

  let embedded = 0;
  for (let i = 0; i < rows.length; i++) {
    const vec = vectors[i];
    if (!vec) continue;
    await rawRun(
      prisma,
      `UPDATE memories
         SET embedding=?, embedding_model=?, embedding_dim=?,
             embedding_status='done', embedding_state_changed_at=unixepoch(),
             embedding_error_kind=NULL, embedding_error_reason=NULL
       WHERE id=? AND embedding_status='pending'`,
      JSON.stringify(vec),
      provider.model,
      provider.dim,
      rows[i].id,
    );
    embedded++;
  }
  logger.info({ scanned: rows.length, embedded }, "local pending sweep complete");
  return { scanned: rows.length, embedded };
}
