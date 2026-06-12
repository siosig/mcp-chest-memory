/**
 * Prisma Client singleton for the SQLite store.
 *
 * - Synthesizes DATABASE_URL from CHEST_DB_PATH when not provided explicitly.
 * - Applies connection PRAGMAs (WAL, busy_timeout, foreign_keys) on first use.
 * - Provides raw-SQL helpers that keep id/timestamp handling identical to the
 *   original engine-agnostic logic (BigInt columns coerced to number).
 * - In CHEST_MODE=remote, Prisma is never loaded — callers must not invoke
 *   database operations in that mode.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { PrismaClient } from "@prisma/client";
import { dbPath } from "../../utils/env.js";

const isRemote = (process.env["CHEST_MODE"] ?? "local") === "remote";

// Global cache guards against multiple client instances (standard Prisma pattern).
// Typed import() keeps this a type-only reference — no runtime module load.
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function withSingleConnection(url: string): string {
  if (url.includes("connection_limit=")) return url;
  return url + (url.includes("?") ? "&" : "?") + "connection_limit=1";
}

// DATABASE_URL is resolved eagerly so that env-var consumers see it immediately.
// In remote mode this is a no-op — no SQLite file will be opened.
function resolveDatabaseUrl(): void {
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
}

/**
 * The Prisma Client singleton.
 *
 * `@prisma/client` is loaded lazily inside `ensurePrismaInitialized()` so that
 * importing this module never pulls in the Prisma engine. This matters for two
 * reasons:
 *  - CHEST_MODE=remote must run without a usable `@prisma/client` (the generated
 *    stub may be uninitialized after a bare `npm install -g`), and a top-level
 *    `import { PrismaClient }` would crash the MCP server on load.
 *  - The engine load is deferred until the first DB-backed operation.
 *
 * Exported as `let` so the live ESM binding is updated in place once the client
 * is constructed. Every consumer reads `prisma` at call time (inside functions),
 * so they observe the initialized instance — and `this` stays bound to the real
 * client, which a Proxy wrapper would have broken.
 *
 * Accessing `prisma` before `ensurePrismaInitialized()` (or at all in remote
 * mode) yields `undefined`; remote mode must never invoke DB operations.
 */
export let prisma: PrismaClient = undefined as unknown as PrismaClient;

let initialized = false;

/**
 * Must be called once at process startup (MCP server / REST backend / CLI).
 * In remote mode this is a no-op.
 * Verifies the connection and applies per-connection PRAGMAs.
 */
export async function ensurePrismaInitialized(): Promise<void> {
  if (isRemote || initialized) return;

  resolveDatabaseUrl();

  const { PrismaClient } = await import("@prisma/client");
  const { ensureSchema } = await import("./migrate.js");

  if (!globalForPrisma.prisma) {
    globalForPrisma.prisma = new PrismaClient({ log: ["warn", "error"] });
  }
  prisma = globalForPrisma.prisma;

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
  if (isRemote || !initialized) return;
  await globalForPrisma.prisma?.$disconnect();
  initialized = false;
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
