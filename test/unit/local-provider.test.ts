// Write-time sync embedding + local pending sweep, exercised with a fake
// provider (no model download in unit tests).
import { describe, test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { resetDb, insEntity, insMemory } from "../helpers/db.js";
import { prisma, rawGet } from "../../src/lib/db/prisma-client.js";
import {
  setActiveProviderForTest,
  type EmbeddingProvider,
} from "../../src/lib/embedding/provider.js";
import { embedMemorySync, runLocalPendingSweep } from "../../src/lib/embedding/sync-embed.js";

const DIM = 4;

function fakeLocal(overrides: Partial<EmbeddingProvider> = {}): EmbeddingProvider {
  return {
    id: "local",
    model: "fake-local-model",
    dim: DIM,
    embedQuery: async () => [1, 0, 0, 0],
    embedPassages: async (texts: string[]) => texts.map(() => [0, 1, 0, 0]),
    ...overrides,
  };
}

interface EmbRow {
  embedding: string | null;
  embedding_model: string | null;
  embedding_dim: number | null;
  embedding_status: string;
}

async function embRow(id: number): Promise<EmbRow> {
  const row = await rawGet<EmbRow>(
    prisma,
    "SELECT embedding, embedding_model, embedding_dim, embedding_status FROM memories WHERE id=?",
    id,
  );
  assert.ok(row);
  return row;
}

beforeEach(async () => {
  await resetDb();
  process.env.CHEST_SYNC_EMBED = "1";
});

after(() => {
  process.env.CHEST_SYNC_EMBED = "0";
  setActiveProviderForTest(undefined);
});

describe("embedMemorySync", () => {
  test("stores vector, model, dim and marks the row done", async () => {
    setActiveProviderForTest(fakeLocal());
    const eid = await insEntity("project", "p");
    const mid = await insMemory(eid, "hello sync embed");

    const ok = await embedMemorySync(mid, "hello sync embed");
    assert.equal(ok, true);

    const row = await embRow(mid);
    assert.equal(row.embedding_status, "done");
    assert.equal(row.embedding_model, "fake-local-model");
    assert.equal(row.embedding_dim, DIM);
    assert.equal((JSON.parse(row.embedding!) as number[]).length, DIM);
  });

  test("model unavailable -> row stays pending (save never fails)", async () => {
    setActiveProviderForTest(fakeLocal({ embedPassages: async () => null }));
    const eid = await insEntity("project", "p");
    const mid = await insMemory(eid, "no model available");

    const ok = await embedMemorySync(mid, "no model available");
    assert.equal(ok, false);
    assert.equal((await embRow(mid)).embedding_status, "pending");
  });

  test("gemini provider is untouched by the sync path (batch cycle owns it)", async () => {
    setActiveProviderForTest({ ...fakeLocal(), id: "gemini" });
    const eid = await insEntity("project", "p");
    const mid = await insMemory(eid, "gemini stays async");

    const ok = await embedMemorySync(mid, "gemini stays async");
    assert.equal(ok, false);
    assert.equal((await embRow(mid)).embedding_status, "pending");
  });
});

describe("runLocalPendingSweep", () => {
  test("backfills pending rows and reports counts", async () => {
    setActiveProviderForTest(fakeLocal());
    const eid = await insEntity("project", "p");
    const a = await insMemory(eid, "pending one");
    const b = await insMemory(eid, "pending two");

    const r = await runLocalPendingSweep(10);
    assert.equal(r.scanned, 2);
    assert.equal(r.embedded, 2);
    assert.equal((await embRow(a)).embedding_status, "done");
    assert.equal((await embRow(b)).embedding_status, "done");
  });

  test("model unavailable -> rows stay pending and are reported as scanned", async () => {
    setActiveProviderForTest(fakeLocal({ embedPassages: async () => null }));
    const eid = await insEntity("project", "p");
    const a = await insMemory(eid, "still pending");

    const r = await runLocalPendingSweep(10);
    assert.equal(r.scanned, 1);
    assert.equal(r.embedded, 0);
    assert.equal((await embRow(a)).embedding_status, "pending");
  });
});
