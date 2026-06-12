// Unit tests for runSubmitPhase
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runSubmitPhase } from "../../../src/lib/embedding/submit.js";
import {
  FakeGeminiBatchClient,
  ApiError,
} from "../../../src/lib/embedding/gemini-client.js";
import { realClock } from "../../../src/lib/embedding/ports.js";
import { prisma, rawAll, rawRun } from "../../../src/lib/db/prisma-client.js";
import { resetDb, insEntity, insMemory } from "../../helpers/db.js";

async function ensureCycleRow(id: string): Promise<void> {
  await rawRun(
    prisma,
    "INSERT INTO batch_cycle_runs (id, started_at) VALUES (?, unixepoch())",
    id,
  );
}

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

describe("runSubmitPhase", () => {
  it("no pending records → no-op returning {submittedCount:0}", async () => {
    await resetDb();
    await ensureCycleRow("test-cycle-1");
    const gemini = new FakeGeminiBatchClient();
    const r = await runSubmitPhase({
      prisma,
      gemini,
      logger: silentLogger,
      clock: realClock,
      cycleId: "test-cycle-1",
      batchSize: 10,
    });
    assert.equal(r.submittedCount, 0);
    assert.equal(gemini.submitCount, 0);
  });

  it("3 pending records submitted in 1 batch → transitioned to in_progress + EmbeddingBatch submitted", async () => {
    await resetDb();
    const eid = await insEntity("project", "p");
    const m1 = await insMemory(eid, "alpha");
    const m2 = await insMemory(eid, "beta");
    const m3 = await insMemory(eid, "gamma");
    await ensureCycleRow("test-cycle-2");
    // all in default pending state
    const gemini = new FakeGeminiBatchClient();
    const r = await runSubmitPhase({
      prisma,
      gemini,
      logger: silentLogger,
      clock: realClock,
      cycleId: "test-cycle-2",
      batchSize: 10,
    });
    assert.equal(r.submittedCount, 3);
    assert.ok(r.batchId, "batchId returned");
    assert.equal(gemini.submitCount, 1);
    // memories are in_progress with batch_id = r.batchId
    const rows = await rawAll<{
      id: number;
      embedding_status: string;
      embedding_batch_id: string | null;
    }>(
      prisma,
      "SELECT id, embedding_status, embedding_batch_id FROM memories WHERE id IN (?, ?, ?) ORDER BY id",
      m1,
      m2,
      m3,
    );
    for (const row of rows) {
      assert.equal(row.embedding_status, "in_progress");
      assert.equal(row.embedding_batch_id, r.batchId);
    }
    // EmbeddingBatch record is in submitted state
    const bRows = await rawAll<{ id: string; status: string; record_count: number }>(
      prisma,
      "SELECT id, status, record_count FROM embedding_batches WHERE id = ?",
      r.batchId,
    );
    assert.equal(bRows.length, 1);
    assert.equal(bRows[0].status, "submitted");
    assert.equal(bRows[0].record_count, 3);
  });

  it("batchSize caps records fetched (5 pending, batchSize=2 → only 2 submitted)", async () => {
    await resetDb();
    const eid = await insEntity("project", "p");
    for (let i = 0; i < 5; i++) {
      await insMemory(eid, `m${i}`);
    }
    await ensureCycleRow("test-cycle-3");
    const gemini = new FakeGeminiBatchClient();
    const r = await runSubmitPhase({
      prisma,
      gemini,
      logger: silentLogger,
      clock: realClock,
      cycleId: "test-cycle-3",
      batchSize: 2,
    });
    assert.equal(r.submittedCount, 2);
    const stillPending = await rawAll<{ c: number }>(
      prisma,
      "SELECT COUNT(*) c FROM memories WHERE embedding_status='pending'",
    );
    assert.equal(Number(stillPending[0].c), 3);
  });

  it("ApiError(transient) → memories reverted to pending + batch failed + rethrow", async () => {
    await resetDb();
    const eid = await insEntity("project", "p");
    const m1 = await insMemory(eid, "alpha");
    await ensureCycleRow("test-cycle-4");
    const gemini = new FakeGeminiBatchClient();
    gemini.setSubmitError(new ApiError("transient", 429, "rate limit"));
    let thrown: unknown;
    try {
      await runSubmitPhase({
        prisma,
        gemini,
        logger: silentLogger,
        clock: realClock,
        cycleId: "test-cycle-4",
        batchSize: 10,
      });
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown instanceof ApiError);
    assert.equal((thrown as ApiError).kind, "transient");
    const row = await rawAll<{ embedding_status: string; embedding_batch_id: string | null }>(
      prisma,
      "SELECT embedding_status, embedding_batch_id FROM memories WHERE id = ?",
      m1,
    );
    assert.equal(row[0].embedding_status, "pending");
    assert.equal(row[0].embedding_batch_id, null);
    // batch is failed
    const bRows = await rawAll<{ status: string }>(
      prisma,
      "SELECT status FROM embedding_batches",
    );
    assert.equal(bRows.length, 1);
    assert.equal(bRows[0].status, "failed");
  });

  it("ApiError(permanent) → memories reverted to pending + batch failed + rethrow", async () => {
    await resetDb();
    const eid = await insEntity("project", "p");
    const m1 = await insMemory(eid, "alpha");
    await ensureCycleRow("test-cycle-5");
    const gemini = new FakeGeminiBatchClient();
    gemini.setSubmitError(new ApiError("permanent", 400, "bad request"));
    let thrown: unknown;
    try {
      await runSubmitPhase({
        prisma,
        gemini,
        logger: silentLogger,
        clock: realClock,
        cycleId: "test-cycle-5",
        batchSize: 10,
      });
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown instanceof ApiError);
    assert.equal((thrown as ApiError).kind, "permanent");
    const row = await rawAll<{ embedding_status: string }>(
      prisma,
      "SELECT embedding_status FROM memories WHERE id = ?",
      m1,
    );
    assert.equal(row[0].embedding_status, "pending");
  });

  it("archived pending records are excluded from submission", async () => {
    await resetDb();
    const eid = await insEntity("project", "p");
    const m1 = await insMemory(eid, "active");
    const m2 = await insMemory(eid, "archived", { archivedAt: 100 });
    await ensureCycleRow("test-cycle-6");
    const gemini = new FakeGeminiBatchClient();
    const r = await runSubmitPhase({
      prisma,
      gemini,
      logger: silentLogger,
      clock: realClock,
      cycleId: "test-cycle-6",
      batchSize: 10,
    });
    assert.equal(r.submittedCount, 1);
    const stillPending = await rawAll<{ id: number }>(
      prisma,
      "SELECT id FROM memories WHERE embedding_status='pending' ORDER BY id",
    );
    // archived record stays pending (not transitioned to in_progress)
    assert.equal(stillPending.length, 1);
    assert.equal(stillPending[0].id, m2);
  });
});
