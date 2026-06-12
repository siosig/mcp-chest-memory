/**
 * Memory Repository — Prisma-backed access to the memories table.
 *
 * Preserves the archive-first lifecycle, decay, and supersession semantics.
 * Decision logic lives in the callers (supersession.ts / decay.ts / forgetting.ts etc.)
 * and is kept bit-exact in those modules.
 */

import type { Memory, Prisma } from "@prisma/client";
import { prisma } from "../prisma-client.js";

export type MemoryRecord = Memory;

export interface CreateMemoryInput {
  entityId: bigint;
  layer: string;
  content: string;
  importance?: number;
  source?: string | null;
  embedding?: string | null;       // JSON string (float array)
  embeddingModel?: string | null;
  expiresAt?: bigint | null;
}

export async function createMemory(input: CreateMemoryInput): Promise<MemoryRecord> {
  return prisma.memory.create({
    data: {
      entityId: input.entityId,
      layer: input.layer,
      content: input.content,
      importance: input.importance ?? 0.5,
      source: input.source ?? null,
      embedding: input.embedding ?? null,
      embeddingModel: input.embeddingModel ?? null,
      expiresAt: input.expiresAt ?? null,
      // `protected` is set automatically by the trigger `trg_protect_realize` for the realize layer
    },
  });
}

export async function findMemoryById(id: bigint): Promise<MemoryRecord | null> {
  return prisma.memory.findUnique({ where: { id } });
}

export interface RecallFilter {
  layer?: string;
  entityId?: bigint;
  includeArchived?: boolean;     // default false (archive-first: exclude archived memories)
  includeSuperseded?: boolean;   // default false
  limit?: number;
  offset?: number;
}

/**
 * Archive-first recall: defaults to archived_at IS NULL + superseded_by_id IS NULL.
 * Individual flags can relax each constraint independently.
 */
export async function findMemoriesForRecall(filter: RecallFilter): Promise<MemoryRecord[]> {
  const where: Prisma.MemoryWhereInput = {};
  if (filter.layer) where.layer = filter.layer;
  if (filter.entityId !== undefined) where.entityId = filter.entityId;
  if (!filter.includeArchived) where.archivedAt = null;
  if (!filter.includeSuperseded) where.supersededById = null;

  return prisma.memory.findMany({
    where,
    take: filter.limit ?? 50,
    skip: filter.offset ?? 0,
    orderBy: [{ importance: "desc" }, { lastAccessedAt: "desc" }],
  });
}

/**
 * Archive a memory (physical DELETE is prohibited; only archived_at is set).
 */
export async function archiveMemory(
  id: bigint,
  supersededById?: bigint,
  supersessionConfidence?: number,
): Promise<MemoryRecord> {
  const data: Prisma.MemoryUpdateInput = {
    archivedAt: BigInt(Math.floor(Date.now() / 1000)),
  };
  if (supersededById !== undefined) {
    data.supersededBy = { connect: { id: supersededById } };
  }
  if (supersessionConfidence !== undefined) {
    data.supersessionConfidence = supersessionConfidence;
  }
  return prisma.memory.update({ where: { id }, data });
}

/**
 * Mark a memory as accessed: update last_accessed_at + access_count and insert
 * a MemoryAccessLog row for ACT-R Base-Level Activation computation.
 */
export async function markAccessed(id: bigint): Promise<void> {
  const now = BigInt(Math.floor(Date.now() / 1000));
  await prisma.$transaction([
    prisma.memory.update({
      where: { id },
      data: {
        lastAccessedAt: now,
        accessCount: { increment: 1 },
      },
    }),
    prisma.memoryAccessLog.create({
      data: { memoryId: id, accessedAt: now },
    }),
  ]);
}

/**
 * Fetch all active memories including embeddings (used by `chest-index up --reembed`).
 */
export async function findActiveMemoriesForReembed(): Promise<MemoryRecord[]> {
  return prisma.memory.findMany({
    where: { archivedAt: null },
    orderBy: { id: "asc" },
  });
}

/**
 * Fetch peer memories in the same layer and entity within a time window and row cap.
 * Results are ordered by createdAt DESC; supersession.ts uses this list for its
 * near-duplicate comparison logic.
 */
export async function findSupersessionCandidates(opts: {
  layer: string;
  entityId: bigint;
  excludeId: bigint;
  sinceUnixSec: bigint;             // time window lower bound (unix seconds)
  peerLimit: number;                // max rows to return
}): Promise<MemoryRecord[]> {
  return prisma.memory.findMany({
    where: {
      layer: opts.layer,
      entityId: opts.entityId,
      id: { not: opts.excludeId },
      archivedAt: null,
      createdAt: { gte: opts.sinceUnixSec },
    },
    orderBy: { createdAt: "desc" },
    take: opts.peerLimit,
  });
}

export async function updateActivationFields(id: bigint, fields: {
  activationScore?: number;
  ttlPenalty?: number;
  supersessionPenalty?: number;
  activationComputedAt?: bigint;
}): Promise<void> {
  await prisma.memory.update({
    where: { id },
    data: {
      activationScore: fields.activationScore,
      ttlPenalty: fields.ttlPenalty,
      supersessionPenalty: fields.supersessionPenalty,
      activationComputedAt: fields.activationComputedAt,
    },
  });
}

export async function countByLayer(): Promise<Record<string, number>> {
  // Uses Prisma groupBy() for type-safe, SQL-strict-mode-compatible aggregation.
  const rows = await prisma.memory.groupBy({
    by: ["layer"],
    where: { archivedAt: null },
    _count: { _all: true },
  });
  return rows.reduce<Record<string, number>>((acc, row) => {
    acc[row.layer] = row._count._all;
    return acc;
  }, {});
}
