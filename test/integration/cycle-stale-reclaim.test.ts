// Integration test: stale reclaim — in_progress older than 24h reverted to pending, error after max cycles
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runEmbedCycle } from "../../src/lib/embedding/cycle.js";
import { FakeGeminiBatchClient } from "../../src/lib/embedding/gemini-client.js";
import { realClock } from "../../src/lib/embedding/ports.js";
import { prisma, rawAll, rawRun } from "../../src/lib/db/prisma-client.js";
import { resetDb, insEntity, insMemory } from "../helpers/db.js";
import {
  STALE_THRESHOLD_SEC,
  STALE_COUNT_MAX,
} from "../../src/lib/embedding/config.js";

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

describe("runEmbedCycle — stale reclaim", () => {
  it("in_progress older than 24h reverted to pending with stale_count++; error after reaching max", async () => {
    await resetDb();
    const eid = await insEntity("project", "p");
    const mid = await insMemory(eid, "stuck");
    const gemini = new FakeGeminiBatchClient();
    const now = Math.floor(Date.now() / 1000);
    // seed an old in_progress state
    await rawRun(
      prisma,
      "UPDATE memories SET embedding_status='in_progress', embedding_state_changed_at=? WHERE id=?",
      now - STALE_THRESHOLD_SEC - 100,
      mid,
    );
    // run STALE_COUNT_MAX cycles → error on the last one
    for (let i = 0; i < STALE_COUNT_MAX; i++) {
      await runEmbedCycle({
        prisma,
        gemini,
        logger: silentLogger,
        clock: realClock,
        maxSubmit: 100,
        maxFetch: 10,
        maxSubmitBatches: 4,
      });
      // reverted to pending → force back to in_progress so the next cycle triggers reclaim again
      if (i < STALE_COUNT_MAX - 1) {
        await rawRun(
          prisma,
          "UPDATE memories SET embedding_status='in_progress', embedding_state_changed_at=? WHERE id=?",
          now - STALE_THRESHOLD_SEC - 100,
          mid,
        );
      }
    }
    const rows = await rawAll<{
      embedding_status: string;
      embedding_error_kind: string | null;
    }>(
      prisma,
      "SELECT embedding_status, embedding_error_kind FROM memories WHERE id=?",
      mid,
    );
    assert.equal(rows[0].embedding_status, "error");
    assert.equal(rows[0].embedding_error_kind, "stale");
  });
});
