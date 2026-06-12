// Integration test: error memory retried via update_memory
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runEmbedCycle } from "../../src/lib/embedding/cycle.js";
import { FakeGeminiBatchClient } from "../../src/lib/embedding/gemini-client.js";
import { realClock } from "../../src/lib/embedding/ports.js";
import { prisma, rawAll } from "../../src/lib/db/prisma-client.js";
import { resetDb, insEntity, insMemory } from "../helpers/db.js";
import { handleChestUpdateMemory } from "../../src/mcp/tools/chest-update-memory.js";

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

class StatefulFakeClient extends FakeGeminiBatchClient {
  failNext = true;
  async submit(texts: string[]) {
    const r = await super.submit(texts);
    if (this.failNext) {
      this.force(r.jobName, {
        state: "failed",
        errorKind: "permanent",
        errorReason: "400",
      });
    } else {
      this.force(r.jobName, { state: "succeeded" });
    }
    return r;
  }
}

describe("runEmbedCycle — error recovery via update_memory", () => {
  it("error → content updated → pending → done on next cycle", async () => {
    await resetDb();
    const eid = await insEntity("project", "p");
    const mid = await insMemory(eid, "original content");
    const gemini = new StatefulFakeClient();
    // first cycle: permanent error
    await runEmbedCycle({
      prisma,
      gemini,
      logger: silentLogger,
      clock: realClock,
      maxSubmit: 100,
      maxFetch: 10,
      maxSubmitBatches: 4,
    });
    let rows = await rawAll<{ embedding_status: string }>(
      prisma,
      "SELECT embedding_status FROM memories WHERE id=?",
      mid,
    );
    assert.equal(rows[0].embedding_status, "error");

    // update_memory with new content → resets to pending
    await handleChestUpdateMemory({
      memory_id: mid,
      content: "fixed content",
    } as never);
    rows = await rawAll<{ embedding_status: string }>(
      prisma,
      "SELECT embedding_status FROM memories WHERE id=?",
      mid,
    );
    assert.equal(rows[0].embedding_status, "pending");

    // second cycle: succeeds
    gemini.failNext = false;
    await runEmbedCycle({
      prisma,
      gemini,
      logger: silentLogger,
      clock: realClock,
      maxSubmit: 100,
      maxFetch: 10,
      maxSubmitBatches: 4,
    });
    rows = await rawAll<{ embedding_status: string }>(
      prisma,
      "SELECT embedding_status FROM memories WHERE id=?",
      mid,
    );
    assert.equal(rows[0].embedding_status, "done");
  });
});
