/**
 * Entity Repository — CRUD operations for entities
 * (person / company / project / concept / file / other) via Prisma.
 */

import type { Entity, Prisma } from "@prisma/client";
import { prisma } from "../prisma-client.js";

export type EntityRecord = Entity;

export interface UpsertEntityInput {
  kind: string;
  name: string;
  normalizedName?: string | null;
  canonicalKey: string;          // unique key
  attributes?: string | null;    // JSON string
}

export async function upsertEntityByCanonicalKey(input: UpsertEntityInput): Promise<EntityRecord> {
  const now = BigInt(Math.floor(Date.now() / 1000));
  return prisma.entity.upsert({
    where: { canonicalKey: input.canonicalKey },
    create: {
      kind: input.kind,
      name: input.name,
      normalizedName: input.normalizedName ?? null,
      canonicalKey: input.canonicalKey,
      attributes: input.attributes ?? null,
    },
    update: {
      name: input.name,
      normalizedName: input.normalizedName ?? null,
      attributes: input.attributes ?? null,
      updatedAt: now,
    },
  });
}

export async function findEntityById(id: bigint): Promise<EntityRecord | null> {
  return prisma.entity.findUnique({ where: { id } });
}

export async function findEntityByCanonicalKey(key: string): Promise<EntityRecord | null> {
  return prisma.entity.findUnique({ where: { canonicalKey: key } });
}

export interface ListEntitiesFilter {
  kind?: string;
  limit?: number;
  offset?: number;
}

export async function listEntities(filter: ListEntitiesFilter): Promise<EntityRecord[]> {
  const where: Prisma.EntityWhereInput = {};
  if (filter.kind) where.kind = filter.kind;
  return prisma.entity.findMany({
    where,
    take: filter.limit ?? 50,
    skip: filter.offset ?? 0,
    orderBy: [{ momentumScore: "desc" }, { updatedAt: "desc" }],
  });
}

export async function updateMomentum(id: bigint, momentumScore: number): Promise<void> {
  const now = BigInt(Math.floor(Date.now() / 1000));
  await prisma.entity.update({
    where: { id },
    data: { momentumScore, momentumAt: now },
  });
}
