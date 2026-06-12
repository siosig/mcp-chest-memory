// Parallel cycle exclusion: verifies FOR UPDATE SKIP LOCKED prevents duplicate processing
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

class AutoSucceedFakeClient extends FakeGeminiBatchClient {
  async submit(texts: string[]) {
    const r = await super.submit(texts);
    this.force(r.jobName, { state: "succeeded" });
    return r;
  }
}

describe("runEmbedCycle — exclusion (FOR UPDATE SKIP LOCKED)", () => {
  it("2 concurrent cycles do not double-process the same memory", async () => {
    await resetDb();
    const eid = await insEntity("project", "p");
    for (let i = 0; i < 20; i++) {
      await insMemory(eid, `t-${i}`);
    }
    const g1 = new AutoSucceedFakeClient();
    const g2 = new AutoSucceedFakeClient();
    const [r1, r2] = await Promise.all([
      runEmbedCycle({
        prisma,
        gemini: g1,
        logger: silentLogger,
        clock: realClock,
        maxSubmit: 100,
        maxFetch: 10,
        maxSubmitBatches: 4,
      }),
      runEmbedCycle({
        prisma,
        gemini: g2,
        logger: silentLogger,
        clock: realClock,
        maxSubmit: 100,
        maxFetch: 10,
        maxSubmitBatches: 4,
      }),
    ]);
    // total done = 20 (no duplicate processing)
    assert.equal(r1.doneAdded + r2.doneAdded, 20);
    const doneCount = await rawAll<{ c: number }>(
      prisma,
      "SELECT COUNT(*) c FROM memories WHERE embedding_status='done'",
    );
    assert.equal(Number(doneCount[0].c), 20);
    // each memory belongs to exactly one batch (no duplicates)
    const batchCounts = await rawAll<{ embedding_batch_id: string | null; c: number }>(
      prisma,
      "SELECT embedding_batch_id, COUNT(*) c FROM memories GROUP BY embedding_batch_id",
    );
    // after ingest, batch_id is cleared to null → group by null covers all 20
    assert.ok(batchCounts.length <= 2);
  });
});
