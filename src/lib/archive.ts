// Archive-first lifecycle. Replaces ALL physical DELETE paths
// (forget / consolidate / DROP / expired) with a reversible archive transition.
//
// Invariant: no memory is ever physically deleted. Every "removal" sets archived_at.
// Idempotent — `WHERE archived_at IS NULL` prevents double-archive.

import { prisma, rawGet, rawRun, type RawClient } from "./db/prisma-client.js";

export type ArchiveReason = "forget" | "cold" | "expired" | "dropped";

const REASON_EVENT: Record<ArchiveReason, string> = {
  forget: "memory_archived", // payload.reason = 'forget'
  cold: "memory_archived", // payload.reason = 'cold'
  expired: "memory_expired",
  dropped: "memory_swept_to_archive",
};

/**
 * Archive a single memory (idempotent). Returns true if this call newly archived it.
 * Records the appropriate event with a reason-tagged payload.
 */
export async function archiveMemory(
  memoryId: number,
  reason: ArchiveReason,
  nowSec?: number,
  client: RawClient = prisma,
): Promise<boolean> {
  const now = nowSec ?? Math.floor(Date.now() / 1000);
  const changes = await rawRun(
    client,
    "UPDATE memories SET archived_at = ? WHERE id = ? AND archived_at IS NULL",
    now,
    memoryId,
  );
  if (changes === 0) return false; // already archived or missing

  const row = await rawGet<{ entity_id: number }>(
    client,
    "SELECT entity_id FROM memories WHERE id = ?",
    memoryId,
  );
  await rawRun(
    client,
    "INSERT INTO events (entity_id, kind, payload) VALUES (?, ?, ?)",
    row?.entity_id ?? null,
    REASON_EVENT[reason],
    JSON.stringify({ reason, memory_id: memoryId }),
  );
  return true;
}

/** Archive many memories in one transaction. Returns the count newly archived. */
export async function archiveMemories(
  memoryIds: number[],
  reason: ArchiveReason,
  nowSec?: number,
): Promise<number> {
  const now = nowSec ?? Math.floor(Date.now() / 1000);
  if (memoryIds.length === 0) return 0;
  return prisma.$transaction(async (tx) => {
    let archived = 0;
    for (const id of memoryIds) {
      if (await archiveMemory(id, reason, now, tx)) archived++;
    }
    return archived;
  });
}
