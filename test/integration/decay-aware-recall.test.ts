// Acceptance tests: recall reads pre-computed decay columns (no realtime ACT-R), filters
// archived/superseded, exposes score_breakdown factors, honours the 3 flags, and emits staleness_warning.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleChestRecall } from "../../src/mcp/tools/chest-recall.js";
import { prisma, rawGet } from "../../src/lib/db/prisma-client.js";
import { resetDb, insEntity, insMemory, type InsMemoryCols } from "../helpers/db.js";
import { setActiveProviderForTest } from "../../src/lib/embedding/provider.js";
import { geminiProvider } from "../../src/lib/embedding/gemini-provider.js";

// These fixtures store 768-dim gemini vectors; pin the matching provider so
// the (model, dim) searchable filter behaves as the assertions expect.
setActiveProviderForTest(geminiProvider);


// Wrapper that reproduces the legacy insMemory defaults (embedding present / activation_computed_at=now).
// Tests that verify staleness override embedding:null / activationComputedAt:<old> via cols.
async function insM(eid: number, content: string, cols: InsMemoryCols = {}): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  return insMemory(eid, content, { embedding: "[0.1,0.2]", activationComputedAt: now, ...cols });
}

async function recall(args: Record<string, unknown>): Promise<any> {
  return JSON.parse(await handleChestRecall(args as never));
}

test("high activation ranks above low activation (decay-aware ordering)", async () => {
  await resetDb();
  const eid = await insEntity("project", "proj-decay");
  const hi = await insM(eid, "deploy alpha", { activationScore: 0.9 });
  const lo = await insM(eid, "deploy bravo", { activationScore: 0.1 });
  const res = await recall({ query: "deploy", entity_name: "proj-decay" });
  const ids = res.memories.map((m: any) => m.id);
  assert.ok(ids.indexOf(hi) < ids.indexOf(lo), "high activation should rank first");
});

test("score_breakdown includes v5 dims + new decay factors (FR-108)", async () => {
  await resetDb();
  const eid = await insEntity("project", "proj-decay");
  await insM(eid, "deploy charlie", { activationScore: 0.7, ttlPenalty: 1.0, supersessionPenalty: 1.0 });
  const res = await recall({ query: "deploy", entity_name: "proj-decay" });
  const b = res.memories[0].score_breakdown;
  for (const k of [
    "relevance",
    "heat",
    "momentum",
    "importance",
    "activation",
    "ttl_penalty",
    "supersession_penalty",
    "activation_computed_at",
  ]) {
    assert.ok(k in b, `breakdown missing ${k}`);
  }
  assert.equal(b.activation, 0.7);
});

test("NULL decay columns are treated as 1.0 (no demotion, backward compatible)", async () => {
  await resetDb();
  const eid = await insEntity("project", "proj-decay");
  await insM(eid, "deploy delta", { activationScore: null, ttlPenalty: null, supersessionPenalty: null });
  const res = await recall({ query: "deploy", entity_name: "proj-decay" });
  assert.equal(res.memories[0].score_breakdown.activation, 1);
  assert.equal(res.memories[0].score_breakdown.ttl_penalty, 1);
});

test("archived + superseded excluded by default; included with flags (FR-105/106)", async () => {
  await resetDb();
  const eid = await insEntity("project", "proj-decay");
  const active = await insM(eid, "deploy echo", { activationScore: 0.5 });
  const arch = await insM(eid, "deploy foxtrot", {
    activationScore: 0.5,
    archivedAt: Math.floor(Date.now() / 1000),
  });
  const sup = await insM(eid, "deploy golf", { activationScore: 0.5, supersededById: active });

  const def = await recall({ query: "deploy", entity_name: "proj-decay" });
  const defIds = def.memories.map((m: any) => m.id);
  assert.ok(defIds.includes(active));
  assert.ok(!defIds.includes(arch), "archived excluded by default");
  assert.ok(!defIds.includes(sup), "superseded excluded by default");

  const withArch = await recall({ query: "deploy", entity_name: "proj-decay", include_archived: true });
  const archRow = withArch.memories.find((m: any) => m.id === arch);
  assert.ok(archRow, "archived included with include_archived");
  assert.ok(archRow.match_reasons.includes("archive_explicit"));

  const withSup = await recall({ query: "deploy", entity_name: "proj-decay", include_superseded: true });
  assert.ok(withSup.memories.find((m: any) => m.id === sup), "superseded included with include_superseded");
});

test("ignore_decay collapses decay factors to 1.0 (FR-106)", async () => {
  await resetDb();
  const eid = await insEntity("project", "proj-decay");
  await insM(eid, "deploy hotel", { activationScore: 0.01 });
  const res = await recall({ query: "deploy", entity_name: "proj-decay", ignore_decay: true });
  assert.equal(res.memories[0].score_breakdown.activation, 1);
});

test("staleness_warning emitted when activation old / embedding missing (FR-108)", async () => {
  await resetDb();
  const eid = await insEntity("project", "proj-decay");
  const old = Math.floor(Date.now() / 1000) - 7200; // 2h ago
  await insM(eid, "deploy india", { activationScore: 0.5, activationComputedAt: old, embedding: null });
  const res = await recall({ query: "deploy", entity_name: "proj-decay" });
  assert.ok(res.staleness_warning, "expected staleness_warning");
  assert.ok(res.staleness_warning.activation_age_minutes >= 60);
  assert.equal(res.staleness_warning.embedding_missing_count, 1);
});

test("mark_accessed appends to memory_access_log (FR-101)", async () => {
  await resetDb();
  const eid = await insEntity("project", "proj-decay");
  const id = await insM(eid, "deploy juliet", { activationScore: 0.5 });
  await recall({ query: "deploy", entity_name: "proj-decay" });
  const c = await rawGet<{ c: number }>(
    prisma,
    "SELECT COUNT(*) c FROM memory_access_log WHERE memory_id=?",
    id,
  );
  assert.ok(c!.c >= 1, "access log row should be written");
});
