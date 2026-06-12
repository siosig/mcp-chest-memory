// Contract tests: the 8 MCP tools preserve their original contract. New optional flags are
// additive; physical-delete is removed (forget/consolidate archive instead).
// All handlers are Prisma/MySQL-based async functions and do not take a db argument
// (only forget/consolidate/recall_file require a Server). DB is initialised via resetDb.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { prisma, rawGet } from "../../src/lib/db/prisma-client.js";
import { resetDb } from "../helpers/db.js";
import { handleChestRemember } from "../../src/mcp/tools/chest-remember.js";
import { handleChestRecall } from "../../src/mcp/tools/chest-recall.js";
import { handleChestForget } from "../../src/mcp/tools/chest-forget.js";
import { handleChestUpdateMemory } from "../../src/mcp/tools/chest-update-memory.js";
import { handleChestListEntities } from "../../src/mcp/tools/chest-list-entities.js";
import { handleChestConsolidate } from "../../src/mcp/tools/chest-consolidate.js";
import { handleChestRecallFile } from "../../src/mcp/tools/chest-recall-file.js";
import { handleChestReadSmart } from "../../src/mcp/tools/chest-read-smart.js";

const STUB = {} as unknown as Server;

const memCount = async (): Promise<number> =>
  (await rawGet<{ c: number }>(prisma, "SELECT COUNT(*) c FROM memories"))!.c;

test("all 8 tool handlers are present (FR-601)", () => {
  for (const fn of [
    handleChestRemember,
    handleChestRecall,
    handleChestForget,
    handleChestUpdateMemory,
    handleChestListEntities,
    handleChestConsolidate,
    handleChestRecallFile,
    handleChestReadSmart,
  ]) {
    assert.equal(typeof fn, "function");
  }
});

test("remember with spec-001 args (no supersedes/expires_at) still returns {ok,memory_id,...}", async () => {
  await resetDb();
  const res = JSON.parse(
    await handleChestRemember({
      entity_name: "X",
      entity_kind: "project",
      layer: "learning",
      content: "hello world",
    } as never),
  );
  assert.equal(res.ok, true);
  assert.equal(typeof res.memory_id, "number");
  assert.equal(res.layer, "learning");
  assert.ok("momentum" in res);
});

test("recall with spec-001 args keeps all v5 response fields incl. score_breakdown 4 dims", async () => {
  await resetDb();
  await handleChestRemember({
    entity_name: "proj",
    entity_kind: "project",
    layer: "learning",
    content: "alpha bravo charlie",
  } as never);
  const res = JSON.parse(await handleChestRecall({ query: "bravo" } as never));
  assert.equal(res.ok, true);
  const m = res.memories[0];
  for (const k of [
    "id",
    "entity",
    "layer",
    "content",
    "importance",
    "pinned",
    "heat",
    "band",
    "composite",
    "match_reasons",
    "score_breakdown",
  ]) {
    assert.ok(k in m, `recall memory missing ${k}`);
  }
  for (const k of ["relevance", "heat", "momentum", "importance"]) {
    assert.ok(k in m.score_breakdown, `score_breakdown missing v5 dim ${k}`);
  }
});

test("forget nonexistent id → {ok:false, error:'... not found'} (spec-001 error preserved)", async () => {
  await resetDb();
  const res = JSON.parse(
    await handleChestForget({ memory_id: 99999, dry_run: false, interactive: false } as never, STUB),
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /not found/);
});

test("physical-delete-zero: forget archives; row remains selectable (SC-002)", async () => {
  await resetDb();
  const r = JSON.parse(
    await handleChestRemember({
      entity_name: "X",
      entity_kind: "project",
      layer: "learning",
      content: "to forget",
    } as never),
  );
  const before = await memCount();
  await handleChestForget({ memory_id: r.memory_id, dry_run: false, interactive: false } as never, STUB);
  const row = await rawGet<{ archived_at: number | null }>(
    prisma,
    "SELECT archived_at FROM memories WHERE id=?",
    r.memory_id,
  );
  assert.ok(row, "row must still exist (no physical delete)");
  assert.ok(row!.archived_at != null);
  assert.equal(await memCount(), before, "COUNT(*) unchanged: forget archives, never deletes");
});

test("update_memory keeps spec-001 contract (memory_id preserved, protected realize guard)", async () => {
  await resetDb();
  const r = JSON.parse(
    await handleChestRemember({
      entity_name: "X",
      entity_kind: "project",
      layer: "realize",
      content: "danger",
    } as never),
  );
  // realize is auto-protected on insert → cannot be demoted to another layer.
  const res = JSON.parse(await handleChestUpdateMemory({ memory_id: r.memory_id, layer: "learning" } as never));
  assert.equal(res.ok, false);
  assert.match(res.error, /protected realize/);
});
