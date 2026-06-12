// Integration test: embed-cycle transient submit error
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runEmbedCycle } from "../../src/lib/embedding/cycle.js";
import {
  FakeGeminiBatchClient,
  ApiError,
} from "../../src/lib/embedding/gemini-client.js";
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

describe("runEmbedCycle — transient submit error", () => {
  it("after transient error memories remain pending; next cycle retries successfully", async () => {
    await resetDb();
    const eid = await insEntity("project", "p");
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(await insMemory(eid, `t-${i}`));
    }
    const gemini = new AutoSucceedFakeClient();
    gemini.setSubmitError(new ApiError("transient", 429, "rate limit"));
    const r1 = await runEmbedCycle({
      prisma,
      gemini,
      logger: silentLogger,
      clock: realClock,
      maxSubmit: 100,
      maxFetch: 10,
      maxSubmitBatches: 4,
    });
    // submit failed → submitted_batches = 0
    assert.equal(r1.submittedBatches, 0);
    // memories remain pending
    const pending = await rawAll<{ c: number }>(
      prisma,
      "SELECT COUNT(*) c FROM memories WHERE embedding_status='pending'",
    );
    assert.equal(Number(pending[0].c), 3);
    // next cycle: gemini error already consumed → succeeds
    const r2 = await runEmbedCycle({
      prisma,
      gemini,
      logger: silentLogger,
      clock: realClock,
      maxSubmit: 100,
      maxFetch: 10,
      maxSubmitBatches: 4,
    });
    assert.equal(r2.submittedBatches, 1);
    assert.equal(r2.doneAdded, 3);
  });
});
