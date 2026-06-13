// T025: Migration contract tests.
// Verifies tokenize backfill logic and FTS behavior after migration.
// The test DB already has the 1_multilingual_fts migration applied (via test-env).
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { prisma, rawAll, rawGet, rawRun } from "../../src/lib/db/prisma-client.js";
import { resetDb, insEntity, insMemory } from "../helpers/db.js";
import { tokenize, resetTokenizerForTest } from "../../src/lib/search/tokenizer.js";
import { handleChestRecall } from "../../src/mcp/tools/chest-recall.js";

// Simulates the tokenize-backfill phase of `chest-index migrate` on the test DB.
async function backfillContentTokenized(batchSize = 50): Promise<number> {
  let total = 0;
  for (;;) {
    const rows = await rawAll<{ id: number; content: string }>(
      prisma,
      "SELECT id, content FROM memories WHERE content_tokenized IS NULL AND archived_at IS NULL LIMIT ?",
      batchSize,
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      const tok = await tokenize(row.content);
      await rawRun(prisma, "UPDATE memories SET content_tokenized = ? WHERE id = ?", tok, row.id);
      total++;
    }
  }
  // Rebuild FTS after backfill.
  await rawRun(prisma, "INSERT INTO memories_fts(memories_fts) VALUES('rebuild')");
  return total;
}

describe("migration contract: content_tokenized backfill", () => {
  beforeEach(async () => {
    await resetDb();
    resetTokenizerForTest();
  });

  it("insMemory with contentTokenized=null leaves row with NULL before backfill", async () => {
    const eid = await insEntity("project", "migration-test");
    const id = await insMemory(eid, "vector search performance test", {
      contentTokenized: null,
    });

    const row = await rawGet<{ content_tokenized: string | null }>(
      prisma,
      "SELECT content_tokenized FROM memories WHERE id = ?",
      id,
    );
    assert.equal(row?.content_tokenized, null, "should be null before backfill");
  });

  it("backfill populates content_tokenized for all NULL rows", async () => {
    const eid = await insEntity("project", "migration-backfill");
    await insMemory(eid, "embedding model selection for Japanese text", { contentTokenized: null });
    await insMemory(eid, "RRF fusion rank algorithm", { contentTokenized: null });

    const count = await backfillContentTokenized();
    assert.equal(count, 2, "should backfill exactly 2 memories");

    const nullRows = await rawAll<{ id: number }>(
      prisma,
      "SELECT id FROM memories WHERE content_tokenized IS NULL",
    );
    assert.equal(nullRows.length, 0, "no NULL rows should remain after backfill");
  });

  it("backfill is idempotent — already-tokenized rows are skipped", async () => {
    const eid = await insEntity("project", "migration-idempotent");
    await insMemory(eid, "first memory with tokens", { contentTokenized: "first memory tokens" });
    await insMemory(eid, "second memory without tokens", { contentTokenized: null });

    const count = await backfillContentTokenized();
    assert.equal(count, 1, "only the NULL row should be backfilled");
  });

  it("FTS can find memories after backfill", async () => {
    const eid = await insEntity("project", "migration-fts");
    const id = await insMemory(eid, "multilingual embedding search quality evaluation", {
      contentTokenized: null,
    });

    await backfillContentTokenized();

    const row = await rawGet<{ content_tokenized: string | null }>(
      prisma,
      "SELECT content_tokenized FROM memories WHERE id = ?",
      id,
    );
    assert.ok(row?.content_tokenized !== null, "content_tokenized should be set after backfill");

    const result = JSON.parse(
      await handleChestRecall({ query: "multilingual search", limit: 5, mark_accessed: false }),
    );
    const found = result.memories?.some((m: { id: number }) => m.id === id);
    assert.ok(found, `memory ${id} should be found via FTS after backfill`);
  });

  it("status-like query: content_tokenized IS NOT NULL count increases after backfill", async () => {
    const eid = await insEntity("project", "migration-status");
    await insMemory(eid, "memory alpha", { contentTokenized: null });
    await insMemory(eid, "memory beta", { contentTokenized: null });

    const before = await rawGet<{ c: number }>(
      prisma,
      "SELECT COUNT(*) c FROM memories WHERE content_tokenized IS NOT NULL AND archived_at IS NULL",
    );
    const beforeCount = Number(before?.c ?? 0);

    await backfillContentTokenized();

    const after = await rawGet<{ c: number }>(
      prisma,
      "SELECT COUNT(*) c FROM memories WHERE content_tokenized IS NOT NULL AND archived_at IS NULL",
    );
    const afterCount = Number(after?.c ?? 0);

    assert.ok(afterCount > beforeCount, "tokenized count should increase after backfill");
  });
});
