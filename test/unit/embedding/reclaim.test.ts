// Unit tests for runReclaim
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runReclaim } from "../../../src/lib/embedding/reclaim.js";
import { realClock } from "../../../src/lib/embedding/ports.js";
import { prisma, rawAll, rawRun } from "../../../src/lib/db/prisma-client.js";
import { resetDb, insEntity, insMemory } from "../../helpers/db.js";
import { STALE_THRESHOLD_SEC, STALE_COUNT_MAX } from "../../../src/lib/embedding/config.js";

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

describe("runReclaim", () => {
  it("in_progress older than 24h reverted to pending with stale_count incremented", async () => {
    await resetDb();
    const eid = await insEntity("project", "p");
    const m1 = await insMemory(eid, "stale");
    const now = Math.floor(Date.now() / 1000);
    await rawRun(
      prisma,
      "UPDATE memories SET embedding_status='in_progress', embedding_state_changed_at=?, embedding_batch_id=NULL WHERE id=?",
      now - STALE_THRESHOLD_SEC - 100,
      m1,
    );
    const r = await runReclaim({
      prisma,
      logger: silentLogger,
      clock: realClock,
      cycleId: "cy",
    });
    assert.equal(r.staleReclaim, 1);
    assert.equal(r.staleErrorAdded, 0);
    const rows = await rawAll<{
      embedding_status: string;
      embedding_stale_count: number;
      embedding_batch_id: string | null;
    }>(
      prisma,
      "SELECT embedding_status, embedding_stale_count, embedding_batch_id FROM memories WHERE id=?",
      m1,
    );
    assert.equal(rows[0].embedding_status, "pending");
    assert.equal(rows[0].embedding_stale_count, 1);
    assert.equal(rows[0].embedding_batch_id, null);
  });

  it("stale_count reaching max limit → error finalised", async () => {
    await resetDb();
    const eid = await insEntity("project", "p");
    const m1 = await insMemory(eid, "exhausted");
    const now = Math.floor(Date.now() / 1000);
    await rawRun(
      prisma,
      "UPDATE memories SET embedding_status='in_progress', embedding_state_changed_at=?, embedding_stale_count=? WHERE id=?",
      now - STALE_THRESHOLD_SEC - 100,
      STALE_COUNT_MAX - 1,
      m1,
    );
    const r = await runReclaim({
      prisma,
      logger: silentLogger,
      clock: realClock,
      cycleId: "cy",
    });
    assert.equal(r.staleReclaim, 0);
    assert.equal(r.staleErrorAdded, 1);
    const rows = await rawAll<{
      embedding_status: string;
      embedding_error_kind: string | null;
    }>(
      prisma,
      "SELECT embedding_status, embedding_error_kind FROM memories WHERE id=?",
      m1,
    );
    assert.equal(rows[0].embedding_status, "error");
    assert.equal(rows[0].embedding_error_kind, "stale");
  });

  it("in_progress below threshold age is not reclaimed", async () => {
    await resetDb();
    const eid = await insEntity("project", "p");
    const m1 = await insMemory(eid, "fresh");
    const now = Math.floor(Date.now() / 1000);
    await rawRun(
      prisma,
      "UPDATE memories SET embedding_status='in_progress', embedding_state_changed_at=? WHERE id=?",
      now - 100,
      m1,
    );
    const r = await runReclaim({
      prisma,
      logger: silentLogger,
      clock: realClock,
      cycleId: "cy",
    });
    assert.equal(r.staleReclaim, 0);
    const rows = await rawAll<{ embedding_status: string }>(
      prisma,
      "SELECT embedding_status FROM memories WHERE id=?",
      m1,
    );
    assert.equal(rows[0].embedding_status, "in_progress");
  });
});
