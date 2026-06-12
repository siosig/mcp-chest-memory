// Write-triggered background maintenance: runs all phases when due,
// throttles repeat calls, and can be disabled via env.
import { describe, test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { resetDb, insEntity, insMemory } from "../helpers/db.js";
import { prisma, rawGet, rawRun } from "../../src/lib/db/prisma-client.js";
import {
  setActiveProviderForTest,
  type EmbeddingProvider,
} from "../../src/lib/embedding/provider.js";
import { maybeRunMaintenance } from "../../src/lib/maintenance.js";

const fakeProvider: EmbeddingProvider = {
  id: "local",
  model: "fake-maint-model",
  dim: 3,
  embedQuery: async () => [1, 0, 0],
  embedPassages: async (texts) => texts.map(() => [0, 1, 0]),
};

beforeEach(async () => {
  await resetDb();
  await rawRun(prisma, "DELETE FROM meta WHERE key = 'last_maintenance_at'");
  setActiveProviderForTest(fakeProvider);
  delete process.env.CHEST_AUTO_MAINTENANCE; // enabled for these tests
  process.env.CHEST_MAINTENANCE_INTERVAL_SEC = "3600";
});

after(() => {
  process.env.CHEST_AUTO_MAINTENANCE = "0"; // restore the test-env default
  delete process.env.CHEST_MAINTENANCE_INTERVAL_SEC;
  setActiveProviderForTest(undefined);
});

describe("maybeRunMaintenance", () => {
  test("runs all phases when due: backfills pending embeddings and stamps meta", async () => {
    const eid = await insEntity("project", "maint");
    const mid = await insMemory(eid, "pending row for the maintenance pass");

    const r = await maybeRunMaintenance();
    assert.equal(r.ran, true);

    const row = await rawGet<{ embedding_status: string; embedding_model: string }>(
      prisma,
      "SELECT embedding_status, embedding_model FROM memories WHERE id=?",
      mid,
    );
    assert.equal(row?.embedding_status, "done", "sweep must backfill pending rows");
    assert.equal(row?.embedding_model, "fake-maint-model");

    const meta = await rawGet<{ value: string }>(
      prisma,
      "SELECT value FROM meta WHERE key = 'last_maintenance_at'",
    );
    assert.ok(meta && Number(meta.value) > 0, "run timestamp must be persisted");
  });

  test("second call within the interval is throttled", async () => {
    const first = await maybeRunMaintenance();
    assert.equal(first.ran, true);

    const second = await maybeRunMaintenance();
    assert.equal(second.ran, false);
    assert.equal(second.reason, "throttled");
  });

  test("runs again once the interval has elapsed", async () => {
    await maybeRunMaintenance();
    // Backdate the stamp beyond the interval.
    await rawRun(
      prisma,
      "UPDATE meta SET value = ? WHERE key = 'last_maintenance_at'",
      String(Math.floor(Date.now() / 1000) - 7200),
    );
    const again = await maybeRunMaintenance();
    assert.equal(again.ran, true);
  });

  test("CHEST_AUTO_MAINTENANCE=0 disables the pass entirely", async () => {
    process.env.CHEST_AUTO_MAINTENANCE = "0";
    try {
      const r = await maybeRunMaintenance();
      assert.equal(r.ran, false);
      assert.equal(r.reason, "disabled");
    } finally {
      delete process.env.CHEST_AUTO_MAINTENANCE;
    }
  });

  test("never throws even when a phase fails", async () => {
    setActiveProviderForTest({
      ...fakeProvider,
      embedPassages: async () => {
        throw new Error("simulated phase failure");
      },
    });
    const eid = await insEntity("project", "maint-err");
    await insMemory(eid, "row that will fail to embed");

    const r = await maybeRunMaintenance();
    // The sweep treats a throwing provider as an error -> result reports it,
    // but the call itself must resolve without throwing.
    assert.equal(typeof r.ran, "boolean");
  });
});
