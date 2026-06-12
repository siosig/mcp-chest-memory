// Integration test: embed-cycle permanent error path (fetch level)
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

// forces failed permanent immediately after submit
class AutoPermanentFailFakeClient extends FakeGeminiBatchClient {
  async submit(texts: string[]) {
    const r = await super.submit(texts);
    this.force(r.jobName, {
      state: "failed",
      errorKind: "permanent",
      errorReason: "400 invalid input",
    });
    return r;
  }
}

describe("runEmbedCycle — fetch permanent error", () => {
  it("permanent error → memories error + kind=permanent; not retried in next cycle", async () => {
    await resetDb();
    const eid = await insEntity("project", "p");
    await insMemory(eid, "bad-content");
    const gemini = new AutoPermanentFailFakeClient();
    const r1 = await runEmbedCycle({
      prisma,
      gemini,
      logger: silentLogger,
      clock: realClock,
      maxSubmit: 100,
      maxFetch: 10,
      maxSubmitBatches: 4,
    });
    assert.equal(r1.submittedBatches, 1);
    assert.equal(r1.errorAdded, 1);
    const rows = await rawAll<{
      embedding_status: string;
      embedding_error_kind: string | null;
    }>(
      prisma,
      "SELECT embedding_status, embedding_error_kind FROM memories",
    );
    assert.equal(rows[0].embedding_status, "error");
    assert.equal(rows[0].embedding_error_kind, "permanent");

    // next cycle: no pending records → submitted=0
    const r2 = await runEmbedCycle({
      prisma,
      gemini,
      logger: silentLogger,
      clock: realClock,
      maxSubmit: 100,
      maxFetch: 10,
      maxSubmitBatches: 4,
    });
    assert.equal(r2.submittedBatches, 0);
    // error memory unchanged
    const rows2 = await rawAll<{ embedding_status: string }>(
      prisma,
      "SELECT embedding_status FROM memories",
    );
    assert.equal(rows2[0].embedding_status, "error");
  });
});
