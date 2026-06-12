/**
 * Prisma Client singleton for the SQLite store.
 *
 * - Synthesizes DATABASE_URL from CHEST_DB_PATH when not provided explicitly.
 * - Applies connection PRAGMAs (WAL, busy_timeout, foreign_keys) on first use.
 * - Provides raw-SQL helpers that keep id/timestamp handling identical to the
 *   original engine-agnostic logic (BigInt columns coerced to number).
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { PrismaClient } from "@prisma/client";
import { dbPath } from "../../utils/env.js";
import { ensureSchema } from "./migrate.js";

// Resolve the SQLite location before the client is instantiated. An explicit
// DATABASE_URL (e.g. file:/data/chest.db inside the Docker backend) wins over
// the CHEST_DB_PATH-derived default.
//
// connection_limit=1 is enforced for two reasons: connection-scoped PRAGMAs
// (busy_timeout, foreign_keys) must apply to every query, and a single
// connection serializes writes within the process so claim-style updates
// cannot race.
function withSingleConnection(url: string): string {
  if (url.includes("connection_limit=")) return url;
  return url + (url.includes("?") ? "&" : "?") + "connection_limit=1";
}

if (!process.env.DATABASE_URL) {
  const file = dbPath();
  try {
    mkdirSync(dirname(file), { recursive: true });
  } catch {
    /* surfaced by the connection attempt below if truly unwritable */
  }
  process.env.DATABASE_URL = withSingleConnection(`file:${file}`);
} else if (process.env.DATABASE_URL.startsWith("file:")) {
  process.env.DATABASE_URL = withSingleConnection(process.env.DATABASE_URL);
}

// Global cache guards against multiple client instances (standard Prisma pattern).
const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined };

function createPrismaClient(): PrismaClient {
  return new PrismaClient({
    log: ["warn", "error"],
  });
}

export const prisma: PrismaClient = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

let initialized = false;

/**
 * Must be called once at process startup (MCP server / REST backend / CLI).
 * Verifies the connection and applies per-connection PRAGMAs.
 */
export async function ensurePrismaInitialized(): Promise<void> {
  if (initialized) return;

  // Apply bundled migrations first so `npx -y mcp-chest-memory` works on a
  // brand-new machine without any separate setup step.
  await ensureSchema();

  // WAL keeps readers non-blocking; busy_timeout smooths over short lock
  // contention; foreign_keys is off by default in SQLite and must be opted in.
  // PRAGMAs may return a result row, so they must go through $queryRawUnsafe.
  await prisma.$queryRawUnsafe("PRAGMA journal_mode=WAL");
  await prisma.$queryRawUnsafe("PRAGMA busy_timeout=5000");
  await prisma.$queryRawUnsafe("PRAGMA foreign_keys=ON");
  await prisma.$queryRaw`SELECT 1 AS ok`;

  initialized = true;
}

export async function shutdownPrisma(): Promise<void> {
  await prisma.$disconnect();
  initialized = false;
}

/**
 * Recursively stringify BigInt values for MCP/JSON responses.
 * Memory.id and friends are bigint and would make JSON.stringify throw.
 */
export function serializeBigInt<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, val) => (typeof val === "bigint" ? val.toString() : val))
  ) as T;
}

/**
 * $queryRaw returns BIGINT columns as `bigint`. The scoring/decay logic does
 * arithmetic on ids and timestamps as `number` (all values < 2^53), so flat
 * rows are coerced once at the boundary.
 */
export function numify<T>(row: T): T {
  if (row === null || typeof row !== "object" || Array.isArray(row)) return row;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
    out[k] = typeof v === "bigint" ? Number(v) : v;
  }
  return out as T;
}

/**
 * Raw SQL client shape satisfied by both the global client and a $transaction
 * client, so existing SQL strings can be executed verbatim.
 */
export type RawClient = {
  $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number>;
  $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T>;
};

/** SELECT -> row array (bigint coerced to number). */
export async function rawAll<T>(client: RawClient, sql: string, ...params: unknown[]): Promise<T[]> {
  const rows = await client.$queryRawUnsafe<T[]>(sql, ...params);
  return (rows as unknown[]).map((r) => numify(r)) as T[];
}

/** SELECT -> first row or undefined. */
export async function rawGet<T>(
  client: RawClient,
  sql: string,
  ...params: unknown[]
): Promise<T | undefined> {
  const rows = await rawAll<T>(client, sql, ...params);
  return rows[0];
}

/** INSERT / UPDATE / DELETE -> affected row count. */
export async function rawRun(client: RawClient, sql: string, ...params: unknown[]): Promise<number> {
  return client.$executeRawUnsafe(sql, ...params);
}

/** Auto-increment id of the most recent INSERT on the same client/transaction. */
export async function lastInsertId(client: RawClient): Promise<number> {
  const rows = await client.$queryRawUnsafe<{ id: bigint }[]>(
    "SELECT last_insert_rowid() AS id"
  );
  return Number(rows[0]?.id ?? 0n);
}
