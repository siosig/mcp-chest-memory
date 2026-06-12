// chest_recall hybrid search (vector + FTS).
// - Injects the vector-fetch function via DI; a fake returning fixed 768-dim vectors drives behavior.
// - Verifies new match_reasons/via values (content_match_vector / vector_only / vector etc.).
// - recall succeeds even when embedQuery returns null (graceful degrade when API key absent).
// - FTS-only results are returned even when there are zero 'done' records.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { handleChestRecall } from "../../src/mcp/tools/chest-recall.js";
import { prisma, rawRun } from "../../src/lib/db/prisma-client.js";
import { resetDb, insEntity, insMemory } from "../helpers/db.js";
import { setActiveProviderForTest } from "../../src/lib/embedding/provider.js";
import { geminiProvider } from "../../src/lib/embedding/gemini-provider.js";

// These fixtures store 768-dim gemini vectors; pin the matching provider so
// the (model, dim) searchable filter behaves as the assertions expect.
setActiveProviderForTest(geminiProvider);


const DIM = 768;

function makeVec(seed: number): number[] {
  // Deterministic L2-normalized pseudo-vector (768-dim). seed controls direction.
  const v = new Array<number>(DIM);
  let s = seed;
  for (let i = 0; i < DIM; i++) {
    s = (s * 1103515245 + 12345) | 0;
    v[i] = ((s >>> 0) % 10000) / 10000 - 0.5;
  }
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
}

/** Directly burn a done + 768-dim vector into a memory via SQL UPDATE (simulates fake batch ingest). */
async function markDone(memoryId: number, vec: number[]): Promise<void> {
  await rawRun(
    prisma,
    "UPDATE memories SET embedding=?, embedding_dim=?, embedding_status='done', embedding_model='gemini-embedding-001' WHERE id=?",
    JSON.stringify(vec),
    vec.length,
    memoryId,
  );
}

describe("chest_recall hybrid vector+FTS", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("returns FTS-only results when queryVec has no cosine similarity with any done record", async () => {
    const eid = await insEntity("project", "proj-hybrid");
    const m1 = await insMemory(eid, "alpha deploy plan");
    await markDone(m1, makeVec(1));

    // Even a different-direction queryVec won't make vector hits zero (cos sim is generally non-zero).
    // This test verifies that FTS is the primary source even with the vector path enabled.
    const res = JSON.parse(
      await handleChestRecall({ query: "alpha" } as never, {
        embedQuery: async () => makeVec(999),
      }),
    );
    assert.equal(res.ok, true);
    assert.ok(res.memories.length >= 1, "FTS hit expected");
    const target = res.memories.find((m: any) => m.id === m1);
    assert.ok(target, "m1 should hit via FTS");
    // FTS and vector may both hit (vector path scans all done candidates) → dual reason is acceptable
    assert.ok(
      target.match_reasons.includes("content_match_fts") ||
        target.match_reasons.includes("content_match_dual"),
      "FTS reason must be present",
    );
  });

  it("returns vector hit with content_match_vector / _via=vector when FTS misses", async () => {
    const eid = await insEntity("project", "proj-hybrid");
    // Use a query completely unrelated to the content so FTS never matches
    const m1 = await insMemory(eid, "完全に無関係な内容のレコードA");
    const targetVec = makeVec(42);
    await markDone(m1, targetVec);

    const res = JSON.parse(
      await handleChestRecall({ query: "xyzqwerty" } as never, {
        embedQuery: async () => targetVec, // same direction → cos sim = 1
      }),
    );
    assert.equal(res.ok, true);
    const target = res.memories.find((m: any) => m.id === m1);
    assert.ok(target, "vector hit expected");
    assert.ok(target.match_reasons.includes("content_match_vector"));
    assert.ok(target.match_reasons.includes("vector_only"));
  });

  it("marks vector+fts when both hit", async () => {
    const eid = await insEntity("project", "proj-hybrid");
    const m1 = await insMemory(eid, "kubernetes cluster upgrade procedure");
    const targetVec = makeVec(7);
    await markDone(m1, targetVec);

    const res = JSON.parse(
      await handleChestRecall({ query: "kubernetes" } as never, {
        embedQuery: async () => targetVec,
      }),
    );
    const target = res.memories.find((m: any) => m.id === m1);
    assert.ok(target, "vector+fts hit expected");
    assert.ok(target.match_reasons.includes("content_match_vector"));
    assert.ok(
      target.match_reasons.includes("content_match_fts") ||
        target.match_reasons.includes("content_match_dual"),
      "FTS reason must also be present",
    );
    // vector_only must not be set (FTS also matched)
    assert.ok(!target.match_reasons.includes("vector_only"));
  });

  it("returns FTS results when embedQuery returns null (graceful degrade, FR-016)", async () => {
    const eid = await insEntity("project", "proj-hybrid");
    const m1 = await insMemory(eid, "graceful degrade path test");
    await markDone(m1, makeVec(3));

    const res = JSON.parse(
      await handleChestRecall({ query: "graceful" } as never, {
        embedQuery: async () => null, // simulates absent GEMINI_API_KEY
      }),
    );
    assert.equal(res.ok, true);
    const target = res.memories.find((m: any) => m.id === m1);
    assert.ok(target);
    assert.ok(!target.match_reasons.includes("content_match_vector"));
    assert.ok(!target.match_reasons.includes("vector_only"));
  });

  it("omits vector path when done=0 (migration just deployed, FR-016)", async () => {
    const eid = await insEntity("project", "proj-hybrid");
    // all records are embedding_status='pending' (default); zero done records
    const m1 = await insMemory(eid, "migration just deployed scenario");

    const res = JSON.parse(
      await handleChestRecall({ query: "migration" } as never, {
        embedQuery: async () => makeVec(11), // query embedding available but zero candidates
      }),
    );
    assert.equal(res.ok, true);
    const target = res.memories.find((m: any) => m.id === m1);
    assert.ok(target, "FTS-only hit expected");
    assert.ok(!target.match_reasons.includes("content_match_vector"));
    assert.ok(!target.match_reasons.includes("vector_only"));
    // staleness_warning must report pending_count >= 1
    assert.ok(res.staleness_warning);
    assert.ok(res.staleness_warning.embedding_missing_count >= 1);
  });
});
