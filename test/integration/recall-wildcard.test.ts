// LIKE wildcard disclosure (High-1). A query/entity/path_substring of "%" must
// not dump the store; literal '%' still matches.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { resetDb, insEntity, insMemory } from "../helpers/db.js";
import { prisma, rawRun } from "../../src/lib/db/prisma-client.js";
import { handleChestRecall } from "../../src/mcp/tools/chest-recall.js";
import { handleChestRecallFile } from "../../src/mcp/tools/chest-recall-file.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

const STUB = {} as unknown as Server;

describe("recall LIKE wildcard escaping", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("chest_recall query '%' returns only literal matches, not the whole store", async () => {
    const e = await insEntity("project", "alpha");
    await insMemory(e, "no wildcard here");
    await insMemory(e, "another plain memory");
    const res = JSON.parse(await handleChestRecall({ query: "%" } as never));
    assert.equal(res.ok, true);
    assert.equal(res.memories.length, 0, "'%' must not match every row");
  });

  it("chest_recall entity_name '%' (with a query) does not match all entities", async () => {
    // entity_name requires an accompanying query; the entity-name LIKE must treat
    // '%' literally so it does not select every entity's memories.
    const a = await insEntity("project", "alpha");
    const b = await insEntity("project", "beta");
    await insMemory(a, "content one");
    await insMemory(b, "content two");
    const res = JSON.parse(
      await handleChestRecall({ query: "content", entity_name: "%" } as never),
    );
    assert.equal(res.ok, true);
    assert.equal(res.memories.length, 0, "'%' entity filter must not match all entities");
  });

  it("a literal '%' in content is still matched by query '50%'", async () => {
    const e = await insEntity("project", "alpha");
    await insMemory(e, "discount is 50% today");
    await insMemory(e, "unrelated");
    const res = JSON.parse(await handleChestRecall({ query: "50%" } as never));
    assert.equal(res.ok, true);
    assert.ok(
      res.memories.some((m: { content: string }) => /50%/.test(m.content)),
      "literal 50% must still match",
    );
  });

  it("chest_recall_file path_substring '%' does not match every file", async () => {
    // Seed an edit whose path contains no '%'. The early COUNT(*) guard returns
    // before any dialect-specific SQL, so this isolates the LIKE-escaping fix.
    await rawRun(
      prisma,
      `INSERT INTO sessions (id, started_at) VALUES (?, ?)`,
      "s1",
      Math.floor(Date.now() / 1000),
    ).catch(async () => {
      // sessions schema may differ; fall back to minimal insert used elsewhere.
    });
    await rawRun(
      prisma,
      `INSERT INTO session_file_edits (session_id, file_path, operation, occurred_at) VALUES (?, ?, ?, ?)`,
      "s1",
      "/home/u/project/file.ts",
      "edit",
      Math.floor(Date.now() / 1000),
    );
    const res = JSON.parse(
      await handleChestRecallFile({ path_substring: "%" } as never, STUB),
    );
    assert.equal(res.count, 0, "'%' must not match every edited path");
  });
});
