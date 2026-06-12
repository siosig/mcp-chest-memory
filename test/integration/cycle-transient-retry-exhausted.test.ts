// Consecutive transient failures up to TRANSIENT_RETRY_MAX → status becomes 'error'
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runEmbedCycle } from "../../src/lib/embedding/cycle.js";
import { FakeGeminiBatchClient } from "../../src/lib/embedding/gemini-client.js";
import { realClock } from "../../src/lib/embedding/ports.js";
import { prisma, rawAll } from "../../src/lib/db/prisma-client.js";
import { resetDb, insEntity, insMemory } from "../helpers/db.js";
import { TRANSIENT_RETRY_MAX } from "../../src/lib/embedding/config.js";

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

class AutoTransientFailFakeClient extends FakeGeminiBatchClient {
  async submit(texts: string[]) {
    const r = await super.submit(texts);
    this.force(r.jobName, {
      state: "failed",
      errorKind: "transient",
      errorReason: "rate limit",
    });
    return r;
  }
}

describe("runEmbedCycle — transient retry exhausted", () => {
  it(`${TRANSIENT_RETRY_MAX} consecutive transient failures → status becomes error`, async () => {
    await resetDb();
    const eid = await insEntity("project", "p");
    await insMemory(eid, "always-fails");
    const gemini = new AutoTransientFailFakeClient();
    for (let i = 0; i < TRANSIENT_RETRY_MAX; i++) {
      await runEmbedCycle({
        prisma,
        gemini,
        logger: silentLogger,
        clock: realClock,
        maxSubmit: 100,
        maxFetch: 10,
        maxSubmitBatches: 4,
      });
    }
    const rows = await rawAll<{
      embedding_status: string;
      embedding_error_kind: string | null;
      embedding_transient_retry_count: number;
    }>(
      prisma,
      "SELECT embedding_status, embedding_error_kind, embedding_transient_retry_count FROM memories",
    );
    assert.equal(rows[0].embedding_status, "error");
    assert.equal(rows[0].embedding_error_kind, "transient");
    // On the error-commit transition, transient_retry_count is not incremented
    // (it retains the value from the last pending-retry, which is MAX-1).
    assert.equal(rows[0].embedding_transient_retry_count, TRANSIENT_RETRY_MAX - 1);
  });
});
