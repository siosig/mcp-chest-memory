/**
 * MemoryAccessLog Repository — ACT-R Base-Level Activation support.
 * Rolling window N=50 is managed at the application layer.
 */

import { prisma } from "../prisma-client.js";

export async function recordAccess(memoryId: bigint, accessedAt?: bigint): Promise<void> {
  await prisma.memoryAccessLog.create({
    data: {
      memoryId,
      accessedAt: accessedAt ?? BigInt(Math.floor(Date.now() / 1000)),
    },
  });
}

/**
 * Fetch access history for a memory (newest first, up to N rows).
 * Used for ACT-R Base-Level Activation computation.
 */
export async function findRecentAccessTimes(memoryId: bigint, limit = 50): Promise<bigint[]> {
  const rows = await prisma.memoryAccessLog.findMany({
    where: { memoryId },
    orderBy: { accessedAt: "desc" },
    take: limit,
    select: { accessedAt: true },
  });
  return rows.map((r) => r.accessedAt);
}

/**
 * Delete old access log entries, keeping only the most recent N rows per memory.
 */
export async function prunePastAccessLogs(memoryId: bigint, keepLastN = 50): Promise<number> {
  // Uses Prisma deleteMany + orderBy + skip — no raw SQL required.
  const recentRows = await prisma.memoryAccessLog.findMany({
    where: { memoryId },
    orderBy: { accessedAt: "desc" },
    skip: keepLastN,
    select: { id: true },
  });
  if (recentRows.length === 0) return 0;
  const result = await prisma.memoryAccessLog.deleteMany({
    where: { id: { in: recentRows.map((r) => r.id) } },
  });
  return result.count;
}
