// Vector recall is restricted to embedding_dim=768.
// Legacy 384-dim vectors that are 'done' must not match on the vector path.
// FTS is dim-agnostic, so the same record may still appear via that path.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { handleChestRecall } from "../../src/mcp/tools/chest-recall.js";
import { prisma, rawRun } from "../../src/lib/db/prisma-client.js";
import { resetDb, insEntity, insMemory } from "../helpers/db.js";
import { setActiveProviderForTest, type EmbeddingProvider } from "../../src/lib/embedding/provider.js";

// Fixtures in this file store 768-dim vectors stamped "test-model-768"; pin a
// matching fake provider so the (model, dim) searchable filter applies.
const fake768: EmbeddingProvider = {
  id: "test-768",
  model: "test-model-768",
  dim: 768,
  embedQuery: async () => null,
  embedPassages: async () => null,
};
setActiveProviderForTest(fake768);


function makeVec(dim: number, seed: number): number[] {
  const v = new Array<number>(dim);
  let s = seed;
  for (let i = 0; i < dim; i++) {
    s = (s * 1103515245 + 12345) | 0;
    v[i] = ((s >>> 0) % 10000) / 10000 - 0.5;
  }
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
}

async function markDone(memoryId: number, vec: number[], dim: number): Promise<void> {
  await rawRun(
    prisma,
    "UPDATE memories SET embedding=?, embedding_dim=?, embedding_status='done', embedding_model=? WHERE id=?",
    JSON.stringify(vec),
    dim,
    dim === 768 ? "test-model-768" : "Xenova/multilingual-e5-small@q8",
    memoryId,
  );
}

describe("vector recall targets embedding_dim=768 only", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("legacy 384-dim does not vector-hit; new 768-dim does vector-hit", async () => {
    const eid = await insEntity("project", "proj-dim");

    // legacy 384-dim data — must be excluded from vector path
    const oldMem = await insMemory(eid, "完全に無関係な内容のレコードOLD");
    const oldVec = makeVec(384, 1);
    await markDone(oldMem, oldVec, 384);

    // new 768-dim data — must vector-hit
    const newMem = await insMemory(eid, "完全に無関係な内容のレコードNEW");
    const newVec = makeVec(768, 2);
    await markDone(newMem, newVec, 768);

    // query embedding is 768-dim, same direction as newVec (cos=1)
    const res = JSON.parse(
      await handleChestRecall({ query: "xyzqwerty" } as never, {
        embedQuery: async () => newVec,
      }),
    );

    // newMem should appear via vector path
    const newRow = res.memories.find((m: any) => m.id === newMem);
    assert.ok(newRow, "768-dim record should vector-hit");
    assert.ok(newRow.match_reasons.includes("content_match_vector"));

    // oldMem must not appear via vector (FTS also misses since query is unrelated)
    const oldRow = res.memories.find((m: any) => m.id === oldMem);
    if (oldRow) {
      assert.ok(
        !oldRow.match_reasons.includes("content_match_vector"),
        "384-dim record must not vector-hit",
      );
    }
  });

  it("only 384-dim done with zero 768-dim candidates → zero vector hits", async () => {
    const eid = await insEntity("project", "proj-dim");
    const oldMem = await insMemory(eid, "古い言語モデル時代の記憶");
    const oldVec = makeVec(384, 7);
    await markDone(oldMem, oldVec, 384);

    // query vector is 768-dim
    const queryVec = makeVec(768, 99);
    const res = JSON.parse(
      await handleChestRecall({ query: "古い" } as never, {
        embedQuery: async () => queryVec,
      }),
    );

    // FTS may hit oldMem, but no vector reason should appear
    for (const m of res.memories) {
      assert.ok(
        !m.match_reasons.includes("content_match_vector"),
        "vector hits must be zero",
      );
      assert.ok(!m.match_reasons.includes("vector_only"));
    }
  });
});
