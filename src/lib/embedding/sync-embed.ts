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

// Upper bound for write-time embedding. The very first call after `npx -y
// mcp-chest-memory` may trigger the one-time model download (~120 MB); the
// save must not hang on that, so on timeout the row stays pending and the
// background sweep finishes the job once the model is ready (the download
// keeps running on the shared extractor promise).
function syncEmbedTimeoutMs(): number {
  const raw = Number(process.env.CHEST_SYNC_EMBED_TIMEOUT_MS ?? "");
  return Number.isFinite(raw) && raw > 0 ? raw : 8000;
}

/**
 * Embed one memory's content in-process and mark it done.
 * Returns true when the vector was stored, false when the row stays pending.
 */
export async function embedMemorySync(memoryId: number, content: string): Promise<boolean> {
  if (syncEmbedDisabled()) return false;
  const provider = activeProvider();
  try {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), syncEmbedTimeoutMs());
      timer.unref?.();
    });
    const vectors = await Promise.race([provider.embedPassages([content]), timeout]).finally(
      () => timer && clearTimeout(timer),
    );
    const vec = vectors?.[0];
    if (!vec) return false;
    await rawRun(
      prisma,
      `UPDATE memories
         SET embedding=?, embedding_model=?, embedding_dim=?,
             embedding_status='done', embedding_state_changed_at=unixepoch()
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

// Rows embedded and persisted per iteration. Keeps each inference call small
// and commits progress incrementally, so an interrupted sweep (Ctrl-C, OOM,
// shutdown) resumes from where it stopped instead of losing the whole pass.
const SWEEP_CHUNK = 64;

/**
 * Backfill pending rows in-process. Used by `chest-index up --embed-cycle`
 * and by `chest-index reembed` after a model change.
 */
export async function runLocalPendingSweep(limit = 200): Promise<LocalSweepResult> {
  const provider = activeProvider();
  const rows = await rawAll<{ id: number; content: string }>(
    prisma,
    `SELECT id, content FROM memories
      WHERE embedding_status='pending' AND archived_at IS NULL
      ORDER BY created_at ASC, id ASC
      LIMIT ?`,
    limit,
  );
  if (rows.length === 0) return { scanned: 0, embedded: 0 };

  let embedded = 0;
  for (let off = 0; off < rows.length; off += SWEEP_CHUNK) {
    const chunk = rows.slice(off, off + SWEEP_CHUNK);
    const vectors = await provider.embedPassages(chunk.map((r) => r.content));
    if (!vectors) {
      logger.warn(
        { scanned: rows.length, embedded },
        "local sweep: model unavailable, remaining rows stay pending",
      );
      return { scanned: rows.length, embedded };
    }
    for (let i = 0; i < chunk.length; i++) {
      const vec = vectors[i];
      if (!vec) continue;
      await rawRun(
        prisma,
        `UPDATE memories
           SET embedding=?, embedding_model=?, embedding_dim=?,
               embedding_status='done', embedding_state_changed_at=unixepoch()
         WHERE id=? AND embedding_status='pending'`,
        JSON.stringify(vec),
        provider.model,
        provider.dim,
        chunk[i].id,
      );
      embedded++;
    }
  }
  logger.info({ scanned: rows.length, embedded }, "local pending sweep complete");
  return { scanned: rows.length, embedded };
}
