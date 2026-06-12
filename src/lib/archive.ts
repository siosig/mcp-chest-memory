// Archive-first lifecycle. Replaces ALL physical DELETE paths
// (forget / consolidate / DROP / expired) with a reversible archive transition.
//
// Invariant: no memory is ever physically deleted. Every "removal" sets archived_at.
// Idempotent — `WHERE archived_at IS NULL` prevents double-archive.

import type { Prisma } from "@prisma/client";
import { prisma } from "./db/prisma-client.js";

// Either the root client or a transaction handle; both expose the ORM model
// delegates used below. PrismaClient is assignable to Prisma.TransactionClient.
type OrmClient = Prisma.TransactionClient;

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
 *
 * Uses the Prisma ORM (no raw SQL): `updateMany` with the `archivedAt: null`
 * guard keeps the idempotent semantics while making column names schema-typed.
 */
export async function archiveMemory(
  memoryId: number,
  reason: ArchiveReason,
  nowSec?: number,
  client: OrmClient = prisma,
): Promise<boolean> {
  const now = nowSec ?? Math.floor(Date.now() / 1000);
  const { count } = await client.memory.updateMany({
    where: { id: BigInt(memoryId), archivedAt: null },
    data: { archivedAt: BigInt(now) },
  });
  if (count === 0) return false; // already archived or missing

  const row = await client.memory.findUnique({
    where: { id: BigInt(memoryId) },
    select: { entityId: true },
  });
  await client.event.create({
    data: {
      entityId: row?.entityId ?? null,
      kind: REASON_EVENT[reason],
      payload: JSON.stringify({ reason, memory_id: memoryId }),
    },
  });
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
