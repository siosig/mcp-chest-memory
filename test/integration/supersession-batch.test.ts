// T029 / US3 Acceptance #1-9 / SC-003,010. Batch flow with a deterministic embedder
// (reliable) + a guarded real-model smoke (skipped if the model isn't cached).
import { test } from "node:test";
import assert from "node:assert/strict";
import { runSupersessPhase, type EmbedFn } from "../../src/lib/supersession.js";
import { handleChestRemember } from "../../src/mcp/tools/chest-remember.js";
import { handleChestRecall } from "../../src/mcp/tools/chest-recall.js";
import { prisma, rawGet } from "../../src/lib/db/prisma-client.js";
import { resetDb, insEntity, insMemory } from "../helpers/db.js";

const fakeEmbed: EmbedFn = async (texts) =>
  texts.map((t) => (/config|\.yml|\.toml|version/i.test(t) ? [1, 0.02, 0] : [0, 1, 0]));

const archivedAt = (id: number) =>
  rawGet<{ archived_at: number | null; superseded_by_id: number | null }>(
    prisma,
    "SELECT archived_at, superseded_by_id FROM memories WHERE id=?",
    id,
  );

test("remember leaves embedding NULL (MCP realtime does no inference, FR-302)", async () => {
  await resetDb();
  const res = JSON.parse(
    await handleChestRemember({
      entity_name: "deploy-config",
      entity_kind: "project",
      layer: "learning",
      content: "Node version is 22",
    } as never),
  );
  const row = await rawGet<{ embedding: string | null; embedding_model: string | null }>(
    prisma,
    "SELECT embedding, embedding_model FROM memories WHERE id=?",
    res.memory_id,
  );
  assert.equal(row!.embedding, null);
  assert.equal(row!.embedding_model, null);
});

test("batch detects supersession; recall top result is the newer memory", async () => {
  await resetDb();
  const eid = await insEntity("project", "deploy-config");
  const now = Math.floor(Date.now() / 1000);
  const m1 = await insMemory(eid, "Node version is 22", { createdAt: now - 100 });
  const m2 = await insMemory(eid, "Node version is 24.14", { createdAt: now });

  await runSupersessPhase(fakeEmbed, { now });

  const m1row = await archivedAt(m1);
  assert.ok(m1row!.archived_at != null, "old superseded+archived");
  assert.equal(m1row!.superseded_by_id, m2);

  const def = JSON.parse(
    await handleChestRecall({ query: "Node version", entity_name: "deploy-config", mark_accessed: false } as never),
  );
  assert.equal(def.memories[0].id, m2, "top result is the newer memory");
  assert.ok(!def.memories.some((m: any) => m.id === m1), "superseded excluded by default");

  const inc = JSON.parse(
    await handleChestRecall({
      query: "Node version",
      entity_name: "deploy-config",
      include_superseded: true,
      mark_accessed: false,
    } as never),
  );
  assert.ok(inc.memories.some((m: any) => m.id === m1), "include_superseded recovers history");
});

test("below-threshold pairs are not superseded (false-positive avoidance, idempotent)", async () => {
  await resetDb();
  const eid = await insEntity("project", "deploy-config");
  const now = Math.floor(Date.now() / 1000);
  const a = await insMemory(eid, "Node version is 22", { createdAt: now - 100 });
  const b = await insMemory(eid, "the weather is sunny today", { createdAt: now });
  await runSupersessPhase(fakeEmbed, { now });
  assert.equal((await archivedAt(a))!.archived_at, null);
  assert.equal((await archivedAt(b))!.archived_at, null);
});

test("real Transformers.js model embeds 384-dim (skipped if model not cached)", async (t) => {
  const { localProvider, LOCAL_EMBEDDING_DIM } = await import("../../src/lib/embedding/local-provider.js");
  const vec = await localProvider.embedQuery("Node version is 22");
  if (!vec) {
    t.skip("local model unavailable (run chest-fetch-model to download it)");
    return;
  }
  assert.equal(vec.length, LOCAL_EMBEDDING_DIM);
});
