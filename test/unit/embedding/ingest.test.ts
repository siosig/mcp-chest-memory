// Unit tests for applyBatchResults
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyBatchResults,
  VectorCountMismatchError,
} from "../../../src/lib/embedding/ingest.js";
import { runSubmitPhase } from "../../../src/lib/embedding/submit.js";
import { FakeGeminiBatchClient } from "../../../src/lib/embedding/gemini-client.js";
import { realClock } from "../../../src/lib/embedding/ports.js";
import { prisma, rawAll, rawRun } from "../../../src/lib/db/prisma-client.js";
import { resetDb, insEntity, insMemory } from "../../helpers/db.js";

async function ensureCycleRow(id: string): Promise<void> {
  await rawRun(
    prisma,
    "INSERT OR IGNORE INTO batch_cycle_runs (id, started_at) VALUES (?, unixepoch())",
    id,
  );
}

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function makeVec(dim: number, seed: number): number[] {
  const v: number[] = [];
  let s = seed;
  for (let i = 0; i < dim; i++) {
    s = (s * 1103515245 + 12345) | 0;
    v[i] = ((s >>> 0) % 10000) / 10000 - 0.5;
  }
  // L2 normalize
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
}

describe("applyBatchResults", () => {
  it("assigns vectors to memories in created_at ascending order and transitions them to done", async () => {
    await resetDb();
    const eid = await insEntity("project", "p");
    const now = Math.floor(Date.now() / 1000);
    const m1 = await insMemory(eid, "first", { createdAt: now - 200 });
    const m2 = await insMemory(eid, "second", { createdAt: now - 100 });
    await ensureCycleRow("cy");
    const gemini = new FakeGeminiBatchClient();
    const r = await runSubmitPhase({
      prisma,
      gemini,
      logger: silentLogger,
      clock: realClock,
      cycleId: "cy",
      batchSize: 10,
    });
    const batchId = r.batchId!;
    const v1 = makeVec(768, 1);
    const v2 = makeVec(768, 2);
    const res = await applyBatchResults({
      prisma,
      batchId,
      vectors: [v1, v2],
      logger: silentLogger,
      clock: realClock,
    });
    assert.equal(res.doneCount, 2);
    const rows = await rawAll<{
      id: number;
      embedding_status: string;
      embedding_dim: number | null;
      embedding_model: string | null;
      embedding: string | null;
    }>(
      prisma,
      "SELECT id, embedding_status, embedding_dim, embedding_model, embedding FROM memories WHERE id IN (?, ?) ORDER BY created_at ASC",
      m1,
      m2,
    );
    assert.equal(rows.length, 2);
    assert.equal(rows[0].id, m1);
    assert.equal(rows[0].embedding_status, "done");
    assert.equal(rows[0].embedding_dim, 768);
    assert.equal(rows[0].embedding_model, "gemini-embedding-001");
    const parsed1 = JSON.parse(rows[0].embedding!);
    assert.equal(parsed1.length, 768);
    assert.deepEqual(parsed1, v1);
    // second record gets v2
    const parsed2 = JSON.parse(rows[1].embedding!);
    assert.deepEqual(parsed2, v2);
    // batch status is succeeded
    const bRow = await rawAll<{ status: string; completed_at: number | null }>(
      prisma,
      "SELECT status, completed_at FROM embedding_batches WHERE id = ?",
      batchId,
    );
    assert.equal(bRow[0].status, "succeeded");
    assert.ok(bRow[0].completed_at != null);
  });

  it("after ingest: embeddingBatchId cleared to null and retry_count reset to 0", async () => {
    await resetDb();
    const eid = await insEntity("project", "p");
    await insMemory(eid, "t1");
    await ensureCycleRow("cy");
    const gemini = new FakeGeminiBatchClient();
    const r = await runSubmitPhase({
      prisma,
      gemini,
      logger: silentLogger,
      clock: realClock,
      cycleId: "cy",
      batchSize: 10,
    });
    await applyBatchResults({
      prisma,
      batchId: r.batchId!,
      vectors: [makeVec(768, 99)],
      logger: silentLogger,
      clock: realClock,
    });
    const rows = await rawAll<{
      embedding_batch_id: string | null;
      embedding_transient_retry_count: number;
      embedding_stale_count: number;
    }>(
      prisma,
      "SELECT embedding_batch_id, embedding_transient_retry_count, embedding_stale_count FROM memories",
    );
    assert.equal(rows[0].embedding_batch_id, null);
    assert.equal(rows[0].embedding_transient_retry_count, 0);
    assert.equal(rows[0].embedding_stale_count, 0);
  });

  it("vector count mismatch throws VectorCountMismatchError; memories remain in_progress (tx rollback)", async () => {
    await resetDb();
    const eid = await insEntity("project", "p");
    const now = Math.floor(Date.now() / 1000);
    const m1 = await insMemory(eid, "first", { createdAt: now - 200 });
    const m2 = await insMemory(eid, "second", { createdAt: now - 100 });
    await ensureCycleRow("cy");
    const gemini = new FakeGeminiBatchClient();
    const r = await runSubmitPhase({
      prisma,
      gemini,
      logger: silentLogger,
      clock: realClock,
      cycleId: "cy",
      batchSize: 10,
    });
    const batchId = r.batchId!;
    // 3 vectors for 2 memories → mismatch
    await assert.rejects(
      applyBatchResults({
        prisma,
        batchId,
        vectors: [makeVec(768, 1), makeVec(768, 2), makeVec(768, 3)],
        logger: silentLogger,
        clock: realClock,
      }),
      (e: Error) => e instanceof VectorCountMismatchError,
    );
    // memories remain in_progress (tx rollback prevents state loss)
    const memRows = await rawAll<{ id: number; embedding_status: string }>(
      prisma,
      "SELECT id, embedding_status FROM memories WHERE id IN (?, ?)",
      m1,
      m2,
    );
    assert.equal(memRows.length, 2);
    for (const row of memRows) {
      assert.equal(row.embedding_status, "in_progress");
    }
    // batch remains submitted (tx rollback); fetch.ts is responsible for marking it failed.
    const bRow = await rawAll<{ status: string }>(
      prisma,
      "SELECT status FROM embedding_batches WHERE id = ?",
      batchId,
    );
    assert.notEqual(bRow[0].status, "succeeded");
  });
});
