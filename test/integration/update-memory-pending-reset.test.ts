// When chest_update_memory changes content, all embedding state columns must be
// reset to pending so a new vector is fetched in the next cycle.
// Updates that leave content unchanged (importance / layer only) must not touch embedding columns.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { resetDb, insEntity, insMemory } from "../helpers/db.js";
import { handleChestUpdateMemory } from "../../src/mcp/tools/chest-update-memory.js";
import { prisma, rawGet, rawRun } from "../../src/lib/db/prisma-client.js";

interface EmbRow {
  embedding: string | null;
  embedding_model: string | null;
  embedding_status: string;
  embedding_batch_id: string | null;
  embedding_dim: number | null;
  embedding_error_kind: string | null;
  embedding_error_reason: string | null;
  embedding_transient_retry_count: number;
  content: string;
  importance: number;
}

const SELECT = `SELECT embedding, embedding_model, embedding_status, embedding_batch_id,
                       embedding_dim, embedding_error_kind, embedding_error_reason,
                       embedding_transient_retry_count, content, importance
                FROM memories WHERE id=?`;

/**
 * Seed a test record simulating an "embedding complete" state:
 * - embedding column contains dummy JSON
 * - embedding_status='done', embedding_dim=768
 * - error fields populated (to assert they are cleared on reset)
 *
 * embedding_batch_id requires a real EmbeddingBatch parent row due to FK constraints,
 * so one is inserted first and then linked.
 */
async function seedDoneMemory(entityId: number, content: string): Promise<number> {
  const id = await insMemory(entityId, content, {
    embedding: JSON.stringify([0.1, 0.2, 0.3]),
    embeddingModel: "gemini-embedding-001",
  });
  // Create EmbeddingBatch parent row (required by FK)
  const batchId = `batches/seed-${id}`;
  await rawRun(
    prisma,
    `INSERT INTO embedding_batches (id, status, record_count) VALUES (?, 'succeeded', 1)`,
    batchId,
  );
  await rawRun(
    prisma,
    `UPDATE memories SET
       embedding_status='done',
       embedding_dim=768,
       embedding_batch_id=?,
       embedding_error_kind='transient',
       embedding_error_reason='prior failure',
       embedding_transient_retry_count=2
     WHERE id=?`,
    batchId,
    id,
  );
  return id;
}

describe("chest_update_memory embedding state reset (FR-019)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("resets embedding state to pending when content changes", async () => {
    const eid = await insEntity("project", "reset-on-content");
    const id = await seedDoneMemory(eid, "original content");

    const res = JSON.parse(
      await handleChestUpdateMemory({
        memory_id: id,
        content: "updated content (different)",
      } as never),
    );
    assert.equal(res.ok, true);

    const row = await rawGet<EmbRow>(prisma, SELECT, id);
    assert.equal(row!.content, "updated content (different)");
    assert.equal(row!.embedding_status, "pending");
    assert.equal(row!.embedding, null, "stale vector must be cleared");
    assert.equal(row!.embedding_dim, null);
    assert.equal(row!.embedding_batch_id, null);
    assert.equal(row!.embedding_error_kind, null);
    assert.equal(row!.embedding_error_reason, null);
    assert.equal(row!.embedding_transient_retry_count, 0);
  });

  it("does NOT touch embedding state when only importance changes", async () => {
    const eid = await insEntity("project", "no-reset-on-importance");
    const id = await seedDoneMemory(eid, "stable content");

    const res = JSON.parse(
      await handleChestUpdateMemory({
        memory_id: id,
        importance: 0.95,
      } as never),
    );
    assert.equal(res.ok, true);

    const row = await rawGet<EmbRow>(prisma, SELECT, id);
    assert.equal(row!.embedding_status, "done", "status must stay done");
    assert.equal(row!.embedding_dim, 768, "dim must stay 768");
    assert.notEqual(row!.embedding, null, "vector must NOT be cleared");
    assert.match(String(row!.embedding_batch_id), /^batches\/seed-/);
    assert.equal(row!.embedding_error_kind, "transient");
    assert.equal(row!.embedding_transient_retry_count, 2);
    assert.equal(row!.importance, 0.95);
  });

  it("does NOT touch embedding state when content is identical to existing", async () => {
    const eid = await insEntity("project", "no-reset-on-noop");
    const id = await seedDoneMemory(eid, "same content");

    const res = JSON.parse(
      await handleChestUpdateMemory({
        memory_id: id,
        content: "same content",
      } as never),
    );
    assert.equal(res.ok, true);

    const row = await rawGet<EmbRow>(prisma, SELECT, id);
    assert.equal(row!.embedding_status, "done");
    assert.equal(row!.embedding_dim, 768);
    assert.notEqual(row!.embedding, null, "identical content → no reset");
    assert.match(String(row!.embedding_batch_id), /^batches\/seed-/);
    assert.equal(row!.embedding_transient_retry_count, 2);
  });
});
