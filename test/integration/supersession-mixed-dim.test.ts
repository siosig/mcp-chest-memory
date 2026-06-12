// Integration test: mixed dimensions — legacy 384-dim peers are excluded from evaluateSupersessionFor
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluateSupersessionFor } from "../../src/lib/supersession.js";
import { prisma, rawAll, rawRun } from "../../src/lib/db/prisma-client.js";
import { resetDb, insEntity, insMemory } from "../helpers/db.js";
import { realClock } from "../../src/lib/embedding/ports.js";
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


const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function vec768(): number[] {
  const v = new Array<number>(768).fill(0);
  v[0] = 1;
  return v;
}

function vec384(): number[] {
  const v = new Array<number>(384).fill(0);
  v[0] = 1;
  return v;
}

describe("evaluateSupersessionFor — mixed dim safety", () => {
  it("384-dim peer is excluded from scan (prevents cosine calculation accident)", async () => {
    await resetDb();
    const eid = await insEntity("project", "p");
    const now = Math.floor(Date.now() / 1000);
    const m1 = await insMemory(eid, "old 384", { createdAt: now - 100, layer: "learning" });
    const m2 = await insMemory(eid, "new 768", { createdAt: now, layer: "learning" });
    // legacy 384-dim
    await rawRun(
      prisma,
      "UPDATE memories SET embedding=?, embedding_dim=384, embedding_model='Xenova/multilingual-e5-small@q8', embedding_status='done' WHERE id=?",
      JSON.stringify(vec384()),
      m1,
    );
    // new 768-dim
    await rawRun(
      prisma,
      "UPDATE memories SET embedding=?, embedding_dim=768, embedding_model='test-model-768', embedding_status='done' WHERE id=?",
      JSON.stringify(vec768()),
      m2,
    );
    const r = await evaluateSupersessionFor(m2, {
      prisma,
      logger: silentLogger,
      clock: realClock,
    });
    // 384-dim peer excluded by dim filter → supersede count 0
    assert.equal(r.supersededCount, 0);
    const rows = await rawAll<{ archived_at: number | null }>(
      prisma,
      "SELECT archived_at FROM memories WHERE id=?",
      m1,
    );
    assert.equal(rows[0].archived_at, null);
  });
});
