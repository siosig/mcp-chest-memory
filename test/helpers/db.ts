// Shared test DB helpers. test-env.js must be imported first: it creates a
// fresh temporary SQLite file and points DATABASE_URL at it before the Prisma
// client singleton initializes.
import "./test-env.js";
import { prisma, rawAll, rawRun, ensurePrismaInitialized } from "../../src/lib/db/prisma-client.js";

let dbVerified = false;

// Safety valve: refuse destructive operations unless the connection points at
// a throwaway test database created by test-env.ts.
async function assertTestDatabase(): Promise<void> {
  if (dbVerified) return;
  const rows = await rawAll<{ file: string | null }>(
    prisma,
    "SELECT file FROM pragma_database_list WHERE name='main'",
  );
  const file = rows[0]?.file ?? "";
  if (!file.includes("chest-test-")) {
    throw new Error(
      `[test guard] connected database '${file}' is not a chest-test temp file; aborting to protect real data.`,
    );
  }
  dbVerified = true;
}

// Child-before-parent order so FK constraints are never violated.
const RESET_TABLES = [
  "memory_access_log",
  "session_file_edits",
  "consolidations",
  "edges",
  "file_facts",
  "file_snapshots",
  "events",
  "session_snapshots",
  "memories",
  "sessions",
  "entities",
];

/** Empty every table. Await at the top of each test. */
export async function resetDb(): Promise<void> {
  await ensurePrismaInitialized();
  await assertTestDatabase();
  for (const t of RESET_TABLES) await rawRun(prisma, `DELETE FROM ${t}`);
}

const nowSec = (): number => Math.floor(Date.now() / 1000);
const toBig = (v: number | null | undefined): bigint | null =>
  v == null ? null : BigInt(Math.floor(v));

/** Create an entity and return its id as number. */
export async function insEntity(
  kind: string,
  name: string,
  extra: { momentumScore?: number; canonicalKey?: string } = {},
): Promise<number> {
  const e = await prisma.entity.create({
    data: {
      kind,
      name,
      momentumScore: extra.momentumScore ?? 0,
      ...(extra.canonicalKey !== undefined ? { canonicalKey: extra.canonicalKey } : {}),
    },
  });
  return Number(e.id);
}

export interface InsMemoryCols {
  layer?: string;
  importance?: number;
  protected?: number;
  createdAt?: number;
  lastAccessedAt?: number;
  accessCount?: number;
  activationScore?: number | null;
  ttlPenalty?: number | null;
  supersessionPenalty?: number | null;
  activationComputedAt?: number | null;
  archivedAt?: number | null;
  supersededById?: number | null;
  embedding?: string | null;
  embeddingModel?: string | null;
  embeddingStatus?: string;
  embeddingDim?: number | null;
  expiresAt?: number | null;
  // Pre-tokenized form for FTS5 (unicode61). Defaults to the raw content so
  // existing tests remain searchable without morphological tokenization.
  contentTokenized?: string | null;
}

/** Create a memory and return its id as number. Decay columns can be overridden. */
export async function insMemory(
  entityId: number,
  content: string,
  cols: InsMemoryCols = {},
): Promise<number> {
  const t = nowSec();
  const m = await prisma.memory.create({
    data: {
      entityId: BigInt(entityId),
      layer: cols.layer ?? "learning",
      content,
      importance: cols.importance ?? 0.5,
      ...(cols.protected !== undefined ? { protected: cols.protected } : {}),
      createdAt: BigInt(cols.createdAt ?? t),
      lastAccessedAt: BigInt(cols.lastAccessedAt ?? t),
      accessCount: cols.accessCount ?? 0,
      activationScore: cols.activationScore ?? null,
      ttlPenalty: cols.ttlPenalty ?? null,
      supersessionPenalty: cols.supersessionPenalty ?? null,
      // Unset means "activation not yet computed" (a runActivationPhase target).
      activationComputedAt: toBig(cols.activationComputedAt),
      archivedAt: toBig(cols.archivedAt),
      supersededById: toBig(cols.supersededById),
      embedding: "embedding" in cols ? cols.embedding ?? null : null,
      embeddingModel: cols.embeddingModel ?? null,
      ...(cols.embeddingStatus !== undefined ? { embeddingStatus: cols.embeddingStatus } : {}),
      ...(cols.embeddingDim !== undefined ? { embeddingDim: cols.embeddingDim } : {}),
      expiresAt: toBig(cols.expiresAt),
      // Default to raw content so FTS (unicode61) can find test memories without
      // requiring explicit tokenization in every test helper call.
      contentTokenized: "contentTokenized" in cols ? cols.contentTokenized : content,
    },
  });
  return Number(m.id);
}

/** Append one row to memory_access_log (for ACT-R activation tests). */
export async function insAccessLog(memoryId: number, accessedAt: number): Promise<void> {
  await prisma.memoryAccessLog.create({
    data: { memoryId: BigInt(memoryId), accessedAt: BigInt(Math.floor(accessedAt)) },
  });
}
