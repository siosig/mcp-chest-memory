// Unit tests for runFetchPhase
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runFetchPhase } from "../../../src/lib/embedding/fetch.js";
import { runSubmitPhase } from "../../../src/lib/embedding/submit.js";
import {
  FakeGeminiBatchClient,
  type FetchResult,
} from "../../../src/lib/embedding/gemini-client.js";
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

async function seedAndSubmit(): Promise<{
  gemini: FakeGeminiBatchClient;
  memoryIds: number[];
  batchId: string;
  jobName: string;
}> {
  const eid = await insEntity("project", "p");
  const m1 = await insMemory(eid, "alpha");
  const m2 = await insMemory(eid, "beta");
  await ensureCycleRow("test-cycle");
  const gemini = new FakeGeminiBatchClient();
  const r = await runSubmitPhase({
    prisma,
    gemini,
    logger: silentLogger,
    clock: realClock,
    cycleId: "test-cycle",
    batchSize: 10,
  });
  const rows = await rawAll<{ external_request_id: string | null }>(
    prisma,
    "SELECT external_request_id FROM embedding_batches WHERE id=?",
    r.batchId!,
  );
  return { gemini, memoryIds: [m1, m2], batchId: r.batchId!, jobName: rows[0].external_request_id! };
}

describe("runFetchPhase", () => {
  it("pending state is skipped; memories remain in_progress", async () => {
    await resetDb();
    const { gemini, memoryIds } = await seedAndSubmit();
    const r = await runFetchPhase({
      prisma,
      gemini,
      logger: silentLogger,
      clock: realClock,
      maxFetch: 10,
    });
    assert.equal(r.fetchedCount, 1);
    assert.equal(r.doneAdded, 0);
    assert.equal(r.errorAdded, 0);
    const rows = await rawAll<{ embedding_status: string }>(
      prisma,
      "SELECT embedding_status FROM memories WHERE id IN (?, ?)",
      memoryIds[0],
      memoryIds[1],
    );
    for (const row of rows) assert.equal(row.embedding_status, "in_progress");
  });

  it("succeeded → memories transitioned to done", async () => {
    await resetDb();
    const { gemini, memoryIds, jobName } = await seedAndSubmit();
    gemini.force(jobName, { state: "succeeded" });
    const r = await runFetchPhase({
      prisma,
      gemini,
      logger: silentLogger,
      clock: realClock,
      maxFetch: 10,
    });
    assert.equal(r.fetchedCount, 1);
    assert.equal(r.doneAdded, 2);
    const rows = await rawAll<{
      embedding_status: string;
      embedding_dim: number | null;
      embedding_model: string | null;
    }>(
      prisma,
      "SELECT embedding_status, embedding_dim, embedding_model FROM memories WHERE id IN (?, ?)",
      memoryIds[0],
      memoryIds[1],
    );
    for (const row of rows) {
      assert.equal(row.embedding_status, "done");
      assert.equal(row.embedding_dim, 768);
      assert.equal(row.embedding_model, "gemini-embedding-001");
    }
  });

  it("failed transient → memories reverted to pending (retry_count++)", async () => {
    await resetDb();
    const { gemini, memoryIds, jobName } = await seedAndSubmit();
    gemini.force(jobName, {
      state: "failed",
      errorKind: "transient",
      errorReason: "5xx upstream",
    });
    const r = await runFetchPhase({
      prisma,
      gemini,
      logger: silentLogger,
      clock: realClock,
      maxFetch: 10,
    });
    assert.equal(r.fetchedCount, 1);
    assert.equal(r.transientRetried, 2);
    const rows = await rawAll<{
      embedding_status: string;
      embedding_transient_retry_count: number;
    }>(
      prisma,
      "SELECT embedding_status, embedding_transient_retry_count FROM memories WHERE id IN (?, ?)",
      memoryIds[0],
      memoryIds[1],
    );
    for (const row of rows) {
      assert.equal(row.embedding_status, "pending");
      assert.equal(row.embedding_transient_retry_count, 1);
    }
  });

  it("expired → permanent error", async () => {
    await resetDb();
    const { gemini, memoryIds, jobName } = await seedAndSubmit();
    gemini.force(jobName, { state: "expired" });
    const r = await runFetchPhase({
      prisma,
      gemini,
      logger: silentLogger,
      clock: realClock,
      maxFetch: 10,
    });
    assert.equal(r.errorAdded, 2);
    const rows = await rawAll<{ embedding_status: string; embedding_error_kind: string | null }>(
      prisma,
      "SELECT embedding_status, embedding_error_kind FROM memories WHERE id IN (?, ?)",
      memoryIds[0],
      memoryIds[1],
    );
    for (const row of rows) {
      assert.equal(row.embedding_status, "error");
      assert.equal(row.embedding_error_kind, "permanent");
    }
  });

  it("vector count mismatch → transient retry: memories reverted to pending + batch marked failed", async () => {
    await resetDb();
    const { gemini, memoryIds, jobName } = await seedAndSubmit();
    // succeeded but vector count exceeds memory count (mirrors real-world 49 vs 27 mismatch)
    const mismatchVectors = [
      new Array(768).fill(0.1),
      new Array(768).fill(0.2),
      new Array(768).fill(0.3), // 1 extra vector
    ];
    // override FakeGemini.fetch
    const origFetch = gemini.fetch.bind(gemini);
    gemini.fetch = async (name: string): Promise<FetchResult> => {
      if (name === jobName) {
        return { state: "succeeded", vectors: mismatchVectors };
      }
      return origFetch(name);
    };
    const r = await runFetchPhase({
      prisma,
      gemini,
      logger: silentLogger,
      clock: realClock,
      maxFetch: 10,
    });
    assert.equal(r.fetchedCount, 1);
    assert.equal(r.doneAdded, 0);
    assert.equal(r.transientRetried, 2);
    const rows = await rawAll<{
      embedding_status: string;
      embedding_batch_id: string | null;
      embedding_transient_retry_count: number;
    }>(
      prisma,
      "SELECT embedding_status, embedding_batch_id, embedding_transient_retry_count FROM memories WHERE id IN (?, ?)",
      memoryIds[0],
      memoryIds[1],
    );
    for (const row of rows) {
      assert.equal(row.embedding_status, "pending");
      assert.equal(row.embedding_batch_id, null);
      assert.equal(row.embedding_transient_retry_count, 1);
    }
    const bRow = await rawAll<{ status: string; error_summary: string | null }>(
      prisma,
      "SELECT status, error_summary FROM embedding_batches WHERE external_request_id=?",
      jobName,
    );
    assert.equal(bRow[0].status, "failed");
    assert.match(bRow[0].error_summary ?? "", /vector count mismatch/);
  });

  it("maxFetch limits the number of batches fetched per cycle", async () => {
    await resetDb();
    // submit 3 batches
    const eid = await insEntity("project", "p");
    const gemini = new FakeGeminiBatchClient();
    for (let i = 0; i < 3; i++) {
      await insMemory(eid, `batch${i}`);
      await ensureCycleRow(`c${i}`);
      await runSubmitPhase({
        prisma,
        gemini,
        logger: silentLogger,
        clock: realClock,
        cycleId: `c${i}`,
        batchSize: 1,
      });
    }
    const r = await runFetchPhase({
      prisma,
      gemini,
      logger: silentLogger,
      clock: realClock,
      maxFetch: 2,
    });
    assert.equal(r.fetchedCount, 2);
  });
});
