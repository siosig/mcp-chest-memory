// Content length validation for chest_remember.
// Content exceeding MAX_CONTENT_CHARS (8000) is rejected with a validation error at ingestion
// time; no record is created. Content exactly at the boundary (= 8000) is accepted and saved as pending.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { resetDb } from "../helpers/db.js";
import { handleChestRemember } from "../../src/mcp/tools/chest-remember.js";
import { MAX_CONTENT_CHARS } from "../../src/lib/embedding/config.js";
import { prisma, rawGet } from "../../src/lib/db/prisma-client.js";

describe("chest_remember content length validation (FR-024)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("rejects content longer than MAX_CONTENT_CHARS (8000)", async () => {
    const tooLong = "a".repeat(MAX_CONTENT_CHARS + 1);
    const before = await rawGet<{ c: number }>(prisma, "SELECT COUNT(*) c FROM memories");

    const res = JSON.parse(
      await handleChestRemember({
        entity_name: "validate",
        entity_kind: "project",
        layer: "learning",
        content: tooLong,
        force: true,
      } as never),
    );

    assert.equal(res.ok, false, "oversized content must be rejected");
    assert.match(
      String(res.error ?? ""),
      /Content too long|content.*long|exceed/i,
      "error message should mention length",
    );
    // error message must include input size and limit so the caller can split and re-submit
    assert.match(String(res.error ?? ""), new RegExp(String(MAX_CONTENT_CHARS)));
    assert.match(String(res.error ?? ""), new RegExp(String(tooLong.length)));

    const after = await rawGet<{ c: number }>(prisma, "SELECT COUNT(*) c FROM memories");
    assert.equal(after!.c, before!.c, "no row inserted on validation error");
  });

  it("accepts content exactly MAX_CONTENT_CHARS (8000)", async () => {
    const exact = "b".repeat(MAX_CONTENT_CHARS);
    const res = JSON.parse(
      await handleChestRemember({
        entity_name: "validate",
        entity_kind: "project",
        layer: "learning",
        content: exact,
        force: true,
      } as never),
    );
    assert.equal(res.ok, true, "exact boundary should succeed");
    assert.equal(typeof res.memory_id, "number");

    const row = await rawGet<{ embedding_status: string; embedding_dim: number | null }>(
      prisma,
      "SELECT embedding_status, embedding_dim FROM memories WHERE id=?",
      res.memory_id,
    );
    assert.equal(row!.embedding_status, "pending");
    assert.equal(row!.embedding_dim, null);
  });

  it("saves new memory with embedding_status=pending", async () => {
    const res = JSON.parse(
      await handleChestRemember({
        entity_name: "validate",
        entity_kind: "project",
        layer: "learning",
        content: "short content under the limit",
      } as never),
    );
    assert.equal(res.ok, true);

    const row = await rawGet<{
      embedding_status: string;
      embedding_dim: number | null;
      embedding: string | null;
    }>(
      prisma,
      "SELECT embedding_status, embedding_dim, embedding FROM memories WHERE id=?",
      res.memory_id,
    );
    assert.equal(row!.embedding_status, "pending");
    assert.equal(row!.embedding_dim, null);
    assert.equal(row!.embedding, null);
  });
});
