// Integration test: embed-cycle terminal pino summary log
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runEmbedCycle } from "../../src/lib/embedding/cycle.js";
import { FakeGeminiBatchClient } from "../../src/lib/embedding/gemini-client.js";
import { realClock } from "../../src/lib/embedding/ports.js";
import { prisma } from "../../src/lib/db/prisma-client.js";
import { resetDb, insEntity, insMemory } from "../helpers/db.js";

class AutoSucceedFakeClient extends FakeGeminiBatchClient {
  async submit(texts: string[]) {
    const r = await super.submit(texts);
    this.force(r.jobName, { state: "succeeded" });
    return r;
  }
}

describe("runEmbedCycle — summary log", () => {
  it("terminal info log contains all required summary fields", async () => {
    await resetDb();
    const eid = await insEntity("project", "p");
    await insMemory(eid, "x");
    await insMemory(eid, "y");
    const gemini = new AutoSucceedFakeClient();

    const captured: Array<{ args: unknown[]; msg?: string }> = [];
    const logger = {
      info: (...args: unknown[]) => {
        captured.push({ args });
      },
      warn: () => {},
      error: () => {},
      debug: () => {},
    };
    await runEmbedCycle({
      prisma,
      gemini,
      logger,
      clock: realClock,
      maxSubmit: 100,
      maxFetch: 10,
      maxSubmitBatches: 4,
    });
    // pino style: logger.info(obj, "embed-cycle complete")
    const summary = captured.find((c) => c.args.some((a) => a === "embed-cycle complete"));
    assert.ok(summary, "embed-cycle complete log was not emitted");
    const payload = summary!.args[0] as Record<string, unknown>;
    assert.ok(typeof payload.cycle_id === "string", "cycle_id");
    assert.ok(typeof payload.started_at === "number", "started_at");
    assert.ok(typeof payload.finished_at === "number", "finished_at");
    assert.ok(typeof payload.duration_ms === "number", "duration_ms");
    assert.equal(payload.pending_before, 2);
    assert.equal(payload.in_progress_before, 0);
    assert.equal(payload.submitted_batches, 1);
    assert.equal(payload.fetched_batches, 1);
    assert.equal(payload.done_added, 2);
    assert.equal(payload.error_added, 0);
    assert.equal(payload.transient_retry, 0);
    assert.equal(payload.stale_reclaim, 0);
  });
});
