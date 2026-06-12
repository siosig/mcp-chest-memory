// Embedding cycle happy path
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runEmbedCycle } from "../../src/lib/embedding/cycle.js";
import { FakeGeminiBatchClient } from "../../src/lib/embedding/gemini-client.js";
import { realClock } from "../../src/lib/embedding/ports.js";
import { prisma, rawAll } from "../../src/lib/db/prisma-client.js";
import { resetDb, insEntity, insMemory } from "../helpers/db.js";

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

// Fake client that forces 'succeeded' immediately after submit
class AutoSucceedFakeClient extends FakeGeminiBatchClient {
  async submit(texts: string[]) {
    const r = await super.submit(texts);
    this.force(r.jobName, { state: "succeeded" });
    return r;
  }
}

describe("runEmbedCycle — happy path", () => {
  it("10 pending memories → all done in 1 cycle", async () => {
    await resetDb();
    const eid = await insEntity("project", "p");
    const ids: number[] = [];
    for (let i = 0; i < 10; i++) {
      ids.push(await insMemory(eid, `text-${i}`));
    }
    const gemini = new AutoSucceedFakeClient();
    const result = await runEmbedCycle({
      prisma,
      gemini,
      logger: silentLogger,
      clock: realClock,
      maxSubmit: 100,
      maxFetch: 10,
      maxSubmitBatches: 4,
    });
    assert.equal(result.submittedBatches, 1);
    assert.equal(result.fetchedBatches, 1);
    assert.equal(result.doneAdded, 10);
    const doneCount = await rawAll<{ c: number }>(
      prisma,
      "SELECT COUNT(*) c FROM memories WHERE embedding_status='done'",
    );
    assert.equal(Number(doneCount[0].c), 10);
    // EmbeddingBatch status='succeeded'
    const batches = await rawAll<{ status: string }>(
      prisma,
      "SELECT status FROM embedding_batches",
    );
    assert.equal(batches.length, 1);
    assert.equal(batches[0].status, "succeeded");
    // BatchCycleRun record must exist
    const runs = await rawAll<{
      id: string;
      pending_count_before: number;
      done_added: number;
      finished_at: number | null;
    }>(prisma, "SELECT id, pending_count_before, done_added, finished_at FROM batch_cycle_runs");
    assert.equal(runs.length, 1);
    assert.equal(runs[0].pending_count_before, 10);
    assert.equal(runs[0].done_added, 10);
    assert.ok(runs[0].finished_at != null);
  });
});
