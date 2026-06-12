// chest_remember: when write-time embedding is unavailable (sync embed
// disabled in the test environment), new rows start in embedding_status
// 'pending' with a fresh state-change timestamp — the sweep picks them up.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { resetDb } from "../helpers/db.js";
import { prisma, rawGet } from "../../src/lib/db/prisma-client.js";
import { handleChestRemember } from "../../src/mcp/tools/chest-remember.js";

describe("chest_remember initial embedding state", () => {
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
        content: "embedding happens after the write, never blocking it",
      } as never),
    ) as { ok: boolean; memory_id: number };
    assert.equal(res.ok, true);

    const row = await rawGet<{
      embedding: string | null;
      embedding_model: string | null;
      embedding_status: string;
      embedding_state_changed_at: number;
    }>(
      prisma,
      `SELECT embedding, embedding_model, embedding_status, embedding_state_changed_at
         FROM memories WHERE id = ?`,
      res.memory_id,
    );
    assert.ok(row);
    assert.equal(row.embedding_status, "pending");
    assert.equal(row.embedding, null);
    assert.equal(row.embedding_model, null);
    assert.ok(row.embedding_state_changed_at >= before - 5);
  });
});
