// `chest-index up --decay` archive sweep.
// One pass: (a) cold-cluster compression + (c) DROP_THRESHOLD sweep — both via
// consolidate() (archive-first) — plus (b) TTL-expired archive. Idempotent:
// every path filters `archived_at IS NULL`, so a re-run archives nothing new.

import { prisma, rawAll, rawGet, rawRun } from "./db/prisma-client.js";
import { consolidate } from "./consolidate.js";
import { archiveMemories } from "./archive.js";

const PIN_IMPORTANCE = 0.9;

export interface DecayResult {
  compressed: number; // cold clusters compressed into learning summaries
  expired: number; // TTL-expired memories archived
  swept: number; // DROP_THRESHOLD memories archived
  scanned: number;
  durationMs: number;
}

/** Active, non-protected, non-goal, non-pinned, TTL-expired memory ids.
 * Memories with incomplete embedding (pending / in_progress / error) are excluded
 * from decay to prevent archiving a memory before its embedding cycle completes,
 * which would leave it unreachable by recall and unprocessable by re-embedding. */
async function expiredIds(now: number): Promise<number[]> {
  const rows = await rawAll<{ id: number }>(
    prisma,
    `SELECT id FROM memories
     WHERE archived_at IS NULL AND expires_at IS NOT NULL AND expires_at < ?
       AND protected = 0 AND layer != 'goal' AND importance < ?
       AND embedding_status = 'done'`,
    now,
    PIN_IMPORTANCE,
  );
  return rows.map((r) => r.id);
}

export async function runDecayPhase(
  opts: { check?: boolean; now?: number } = {},
): Promise<DecayResult> {
  const start = Date.now();
  const now = opts.now ?? Math.floor(Date.now() / 1000);

  if (opts.check) {
    const expired = (await expiredIds(now)).length;
    const scannedRow = await rawGet<{ c: number }>(
      prisma,
      "SELECT COUNT(*) c FROM memories WHERE archived_at IS NULL AND protected = 0",
    );
    return { compressed: 0, expired, swept: 0, scanned: Number(scannedRow?.c ?? 0), durationMs: Date.now() - start };
  }

  // (a) cold-cluster compression + (c) DROP_THRESHOLD sweep (both archive-first now).
  const con = await consolidate({ scope: "all" });

  // (b) TTL-expired → archive.
  const expired = await archiveMemories(await expiredIds(now), "expired", now);

  const result: DecayResult = {
    compressed: con.clustersCompressed,
    expired,
    swept: con.memoriesDropped,
    scanned: con.scanned,
    durationMs: Date.now() - start,
  };

  await rawRun(
    prisma,
    "INSERT INTO events (kind, payload) VALUES ('decay_batch_completed', ?)",
    JSON.stringify({
      compressed: result.compressed,
      archived_originals: con.memoriesReplaced,
      expired: result.expired,
      swept: result.swept,
      scanned: result.scanned,
      duration_ms: result.durationMs,
    }),
  );

  return result;
}
