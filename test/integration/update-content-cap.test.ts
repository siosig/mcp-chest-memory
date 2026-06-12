// chest_update_memory content cap (High-3). The update path must enforce the
// same MAX_CONTENT_CHARS limit as chest_remember.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { resetDb, insEntity, insMemory } from "../helpers/db.js";
import { MAX_CONTENT_CHARS } from "../../src/lib/embedding/config.js";
import { prisma, rawGet } from "../../src/lib/db/prisma-client.js";
import { handleChestUpdateMemory } from "../../src/mcp/tools/chest-update-memory.js";

describe("chest_update_memory content cap", () => {
  let memId: number;

  beforeEach(async () => {
    await resetDb();
    const e = await insEntity("project", "alpha");
    memId = await insMemory(e, "original", { layer: "learning" });
  });

  it("rejects content longer than MAX_CONTENT_CHARS", async () => {
    const tooLong = "a".repeat(MAX_CONTENT_CHARS + 1);
    const res = JSON.parse(
      await handleChestUpdateMemory({ memory_id: memId, content: tooLong } as never),
    );
    assert.equal(res.ok, false);
    assert.match(res.error, /too long/i);
    const row = await rawGet<{ content: string }>(
      prisma,
      "SELECT content FROM memories WHERE id = ?",
      memId,
    );
    assert.equal(row!.content, "original", "content must be unchanged on rejection");
  });

  it("accepts content exactly at the limit", async () => {
    const atLimit = "b".repeat(MAX_CONTENT_CHARS);
    const res = JSON.parse(
      await handleChestUpdateMemory({ memory_id: memId, content: atLimit } as never),
    );
    assert.equal(res.ok, true);
    assert.ok(res.updated_fields.includes("content"));
  });
});
