// chest_update_memory: a content change invalidates the stored vector
// (status back to pending so the sweep re-embeds); non-content updates leave
// the embedding state untouched.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { resetDb, insEntity, insMemory } from "../helpers/db.js";
import { prisma, rawGet } from "../../src/lib/db/prisma-client.js";
import { handleChestUpdateMemory } from "../../src/mcp/tools/chest-update-memory.js";

interface EmbRow {
  embedding: string | null;
  embedding_model: string | null;
  embedding_dim: number | null;
  embedding_status: string;
  content: string;
  importance: number;
}

const SELECT = `SELECT embedding, embedding_model, embedding_dim, embedding_status,
                       content, importance
                  FROM memories WHERE id = ?`;

async function row(id: number): Promise<EmbRow> {
  const r = await rawGet<EmbRow>(prisma, SELECT, id);
  assert.ok(r);
  return r;
}

async function seedDoneMemory(): Promise<number> {
  const eid = await insEntity("project", "update-reset");
  return insMemory(eid, "original content for the reset test", {
    embedding: JSON.stringify([0.1, 0.2, 0.3]),
    embeddingModel: "test-model-768",
    embeddingDim: 3,
    embeddingStatus: "done",
  });
}

describe("chest_update_memory embedding invalidation", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("resets embedding state to pending when content changes", async () => {
    const id = await seedDoneMemory();
    const res = JSON.parse(
      await handleChestUpdateMemory({ memory_id: id, content: "completely new content" } as never),
    ) as { ok: boolean };
    assert.equal(res.ok, true);

    const r = await row(id);
    assert.equal(r.content, "completely new content");
    assert.equal(r.embedding_status, "pending");
    assert.equal(r.embedding, null);
    assert.equal(r.embedding_model, null);
    assert.equal(r.embedding_dim, null);
  });

  it("does NOT touch embedding state when only importance changes", async () => {
    const id = await seedDoneMemory();
    const res = JSON.parse(
      await handleChestUpdateMemory({ memory_id: id, importance: 0.9 } as never),
    ) as { ok: boolean };
    assert.equal(res.ok, true);

    const r = await row(id);
    assert.equal(r.importance, 0.9);
    assert.equal(r.embedding_status, "done");
    assert.equal(r.embedding_model, "test-model-768");
    assert.ok(r.embedding);
  });

  it("does NOT touch embedding state when content is identical to existing", async () => {
    const id = await seedDoneMemory();
    const res = JSON.parse(
      await handleChestUpdateMemory({
        memory_id: id,
        content: "original content for the reset test",
      } as never),
    ) as { ok: boolean };
    assert.equal(res.ok, true);

    const r = await row(id);
    assert.equal(r.embedding_status, "done");
    assert.ok(r.embedding);
  });
});
