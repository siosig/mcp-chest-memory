// After chest_remember, embedding_status must be 'pending' and
// embedding_state_changed_at must be approximately the current epoch second.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { resetDb } from "../helpers/db.js";
import { handleChestRemember } from "../../src/mcp/tools/chest-remember.js";
import { prisma, rawGet } from "../../src/lib/db/prisma-client.js";

describe("chest_remember pending status (FR-001, FR-003)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("sets embedding_status=pending and embedding_state_changed_at≈now on insert", async () => {
    const before = Math.floor(Date.now() / 1000);

    const res = JSON.parse(
      await handleChestRemember({
        entity_name: "pending-status",
        entity_kind: "project",
        layer: "learning",
        content: "fresh memory awaiting embedding",
      } as never),
    );
    assert.equal(res.ok, true);

    const after = Math.floor(Date.now() / 1000);
    const row = await rawGet<{
      embedding_status: string;
      embedding_dim: number | null;
      embedding: string | null;
      embedding_state_changed_at: number;
      embedding_batch_id: string | null;
      embedding_error_kind: string | null;
      embedding_transient_retry_count: number;
      embedding_stale_count: number;
    }>(
      prisma,
      `SELECT embedding_status, embedding_dim, embedding, embedding_state_changed_at,
              embedding_batch_id, embedding_error_kind,
              embedding_transient_retry_count, embedding_stale_count
       FROM memories WHERE id=?`,
      res.memory_id,
    );

    assert.equal(row!.embedding_status, "pending");
    assert.equal(row!.embedding_dim, null, "dim should be null pre-embedding");
    assert.equal(row!.embedding, null, "vector should be null pre-embedding");
    assert.equal(row!.embedding_batch_id, null);
    assert.equal(row!.embedding_error_kind, null);
    assert.equal(row!.embedding_transient_retry_count, 0);
    assert.equal(row!.embedding_stale_count, 0);

    const stateTs = Number(row!.embedding_state_changed_at);
    assert.ok(
      stateTs >= before - 1 && stateTs <= after + 1,
      `embedding_state_changed_at (${stateTs}) should be within [${before - 1}, ${after + 1}]`,
    );
  });
});
