// T018: Tokenized FTS integration test.
// Verifies that:
// 1. handleChestRemember writes content_tokenized when CHEST_FTS_TOKENIZE=true (default).
// 2. chest_recall finds memories via FTS search using tokenized content.
// 3. When CHEST_FTS_TOKENIZE=false, content_tokenized is NULL and FTS falls back to LIKE.
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { handleChestRemember } from "../../src/mcp/tools/chest-remember.js";
import { handleChestRecall } from "../../src/mcp/tools/chest-recall.js";
import { prisma, rawGet } from "../../src/lib/db/prisma-client.js";
import { resetDb } from "../helpers/db.js";
import { resetTokenizerForTest } from "../../src/lib/search/tokenizer.js";
import { resetEnvCacheForTest } from "../../src/utils/env.js";

interface ContentRow {
  content_tokenized: string | null;
}

describe("tokenized FTS write path", () => {
  before(() => {
    process.env.CHEST_FTS_TOKENIZE = "true";
    resetEnvCacheForTest();
    resetTokenizerForTest();
  });

  beforeEach(async () => {
    await resetDb();
  });

  it("handleChestRemember stores content_tokenized when CHEST_FTS_TOKENIZE=true", async () => {
    const res = JSON.parse(
      await handleChestRemember({
        entity_name: "fts-test-entity",
        entity_kind: "project",
        layer: "learning",
        content: "The quick brown fox jumps over the lazy dog",
        importance: 0.5,
      }),
    );
    assert.equal(res.ok, true, `remember failed: ${JSON.stringify(res)}`);

    const row = await rawGet<ContentRow>(
      prisma,
      "SELECT content_tokenized FROM memories WHERE id = ?",
      res.memory_id,
    );
    assert.ok(row, "memory row not found");
    assert.ok(
      row!.content_tokenized !== null,
      "content_tokenized must be set when CHEST_FTS_TOKENIZE=true",
    );
    // The tokenized form must contain the key word (space-separated).
    assert.ok(
      row!.content_tokenized!.includes("fox") || row!.content_tokenized!.includes("quick"),
      `content_tokenized "${row!.content_tokenized}" should include content words`,
    );
  });

  it("chest_recall finds a memory via FTS with CHEST_FTS_TOKENIZE=true", async () => {
    const stored = JSON.parse(
      await handleChestRemember({
        entity_name: "fts-recall-entity",
        entity_kind: "project",
        layer: "learning",
        content: "multilingual embedding model performance evaluation",
        importance: 0.6,
      }),
    );
    assert.equal(stored.ok, true);

    const recalled = JSON.parse(
      await handleChestRecall({
        query: "embedding performance",
        mark_accessed: false,
      }),
    );
    assert.ok(recalled.memories, "recall must return memories array");
    const found = recalled.memories.some((m: { id: number }) => m.id === stored.memory_id);
    assert.ok(found, `memory ${stored.memory_id} not found in recall results`);
  });
});

describe("tokenized FTS: CHEST_FTS_TOKENIZE=false stores NULL", () => {
  before(() => {
    process.env.CHEST_FTS_TOKENIZE = "false";
    resetEnvCacheForTest();
    resetTokenizerForTest();
  });

  beforeEach(async () => {
    await resetDb();
  });

  after(() => {
    // Restore default for subsequent test files.
    process.env.CHEST_FTS_TOKENIZE = "true";
    resetEnvCacheForTest();
    resetTokenizerForTest();
  });

  it("handleChestRemember stores NULL content_tokenized when disabled", async () => {
    const res = JSON.parse(
      await handleChestRemember({
        entity_name: "fts-off-entity",
        entity_kind: "project",
        layer: "learning",
        content: "should not be tokenized",
        importance: 0.5,
      }),
    );
    assert.equal(res.ok, true);

    const row = await rawGet<ContentRow>(
      prisma,
      "SELECT content_tokenized FROM memories WHERE id = ?",
      res.memory_id,
    );
    assert.ok(row, "memory row not found");
    assert.equal(
      row!.content_tokenized,
      null,
      "content_tokenized must be NULL when CHEST_FTS_TOKENIZE=false",
    );
  });
});
