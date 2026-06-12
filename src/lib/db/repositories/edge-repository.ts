/**
 * Edge Repository — Layer 2 graph edges between entities.
 */

import type { Edge, Prisma } from "@prisma/client";
import { prisma } from "../prisma-client.js";

export type EdgeRecord = Edge;

export interface UpsertEdgeInput {
  fromId: bigint;
  toId: bigint;
  relation: string;
  weight?: number;
  attributes?: string | null;
}

export async function upsertEdge(input: UpsertEdgeInput): Promise<EdgeRecord> {
  return prisma.edge.upsert({
    where: {
      fromId_toId_relation: {
        fromId: input.fromId,
        toId: input.toId,
        relation: input.relation,
      },
    },
    create: {
      fromId: input.fromId,
      toId: input.toId,
      relation: input.relation,
      weight: input.weight ?? 1.0,
      attributes: input.attributes ?? null,
    },
    update: {
      weight: input.weight ?? 1.0,
      attributes: input.attributes ?? null,
    },
  });
}

export interface ListEdgesFilter {
  fromId?: bigint;
  toId?: bigint;
  relation?: string;
  limit?: number;
}

export async function listEdges(filter: ListEdgesFilter): Promise<EdgeRecord[]> {
  const where: Prisma.EdgeWhereInput = {};
  if (filter.fromId !== undefined) where.fromId = filter.fromId;
  if (filter.toId !== undefined) where.toId = filter.toId;
  if (filter.relation) where.relation = filter.relation;
  return prisma.edge.findMany({
    where,
    take: filter.limit ?? 100,
    orderBy: { weight: "desc" },
  });
}
