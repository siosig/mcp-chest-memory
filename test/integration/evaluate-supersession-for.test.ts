// evaluateSupersessionFor hardening: 6 cases with fixed 768-dim vectors
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluateSupersessionFor } from "../../src/lib/supersession.js";
import { prisma, rawAll, rawRun } from "../../src/lib/db/prisma-client.js";
import { resetDb, insEntity, insMemory } from "../helpers/db.js";
import { realClock } from "../../src/lib/embedding/ports.js";
import { setActiveProviderForTest } from "../../src/lib/embedding/provider.js";
import { geminiProvider } from "../../src/lib/embedding/gemini-provider.js";

// These fixtures store 768-dim gemini vectors; pin the matching provider so
// the (model, dim) searchable filter behaves as the assertions expect.
setActiveProviderForTest(geminiProvider);


const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

// 768-dim unit vector: index 0 = 1, rest = 0
function unitVec(): number[] {
  const v = new Array<number>(768).fill(0);
  v[0] = 1;
  return v;
}

// Slightly shifted vector (cos = 1)
function sameVec(): number[] {
  return unitVec();
}

// Orthogonal vector (cos = 0)
function orthoVec(): number[] {
  const v = new Array<number>(768).fill(0);
  v[1] = 1;
  return v;
}

async function setEmbedding(
  id: number,
  vec: number[],
  dim = 768,
  model = "gemini-embedding-001",
): Promise<void> {
  await rawRun(
    prisma,
    "UPDATE memories SET embedding=?, embedding_dim=?, embedding_model=?, embedding_status='done' WHERE id=?",
    JSON.stringify(vec),
    dim,
    model,
    id,
  );
}

describe("evaluateSupersessionFor — hardening", () => {
  it("same layer + cos>=0.97 → supersession applies", async () => {
    await resetDb();
    const eid = await insEntity("project", "p");
    const now = Math.floor(Date.now() / 1000);
    const m1 = await insMemory(eid, "old config", { createdAt: now - 100, layer: "learning" });
    const m2 = await insMemory(eid, "new config", { createdAt: now, layer: "learning" });
    await setEmbedding(m1, sameVec());
    await setEmbedding(m2, sameVec());
    const r = await evaluateSupersessionFor(m2, {
      prisma,
      logger: silentLogger,
      clock: realClock,
    });
    assert.equal(r.supersededCount, 1);
    const rows = await rawAll<{ archived_at: number | null }>(
      prisma,
      "SELECT archived_at FROM memories WHERE id=?",
      m1,
    );
    assert.ok(rows[0].archived_at != null);
  });

  it("different layer → not a supersession candidate", async () => {
    await resetDb();
    const eid = await insEntity("project", "p");
    const now = Math.floor(Date.now() / 1000);
    const m1 = await insMemory(eid, "old", { createdAt: now - 100, layer: "realize" });
    const m2 = await insMemory(eid, "new", { createdAt: now, layer: "learning" });
    await setEmbedding(m1, sameVec());
    await setEmbedding(m2, sameVec());
    const r = await evaluateSupersessionFor(m2, {
      prisma,
      logger: silentLogger,
      clock: realClock,
    });
    assert.equal(r.supersededCount, 0);
  });

  it("identical JSON shape → skipped before cosine comparison", async () => {
    await resetDb();
    const eid = await insEntity("project", "p");
    const now = Math.floor(Date.now() / 1000);
    const m1 = await insMemory(eid, JSON.stringify({ a: 1, b: 2 }), { createdAt: now - 100, layer: "learning" });
    const m2 = await insMemory(eid, JSON.stringify({ a: 9, b: 8 }), { createdAt: now, layer: "learning" });
    await setEmbedding(m1, sameVec());
    await setEmbedding(m2, sameVec());
    const r = await evaluateSupersessionFor(m2, {
      prisma,
      logger: silentLogger,
      clock: realClock,
    });
    assert.equal(r.supersededCount, 0);
  });

  it("peer outside 90-day window → not a candidate", async () => {
    await resetDb();
    const eid = await insEntity("project", "p");
    const now = Math.floor(Date.now() / 1000);
    const m1 = await insMemory(eid, "way old", {
      createdAt: now - 91 * 86_400,
      layer: "learning",
    });
    const m2 = await insMemory(eid, "new", { createdAt: now, layer: "learning" });
    await setEmbedding(m1, sameVec());
    await setEmbedding(m2, sameVec());
    const r = await evaluateSupersessionFor(m2, {
      prisma,
      logger: silentLogger,
      clock: realClock,
    });
    assert.equal(r.supersededCount, 0);
  });

  it("cos < 0.97 → no supersession", async () => {
    await resetDb();
    const eid = await insEntity("project", "p");
    const now = Math.floor(Date.now() / 1000);
    const m1 = await insMemory(eid, "old", { createdAt: now - 100, layer: "learning" });
    const m2 = await insMemory(eid, "new", { createdAt: now, layer: "learning" });
    await setEmbedding(m1, orthoVec()); // cos = 0
    await setEmbedding(m2, sameVec());
    const r = await evaluateSupersessionFor(m2, {
      prisma,
      logger: silentLogger,
      clock: realClock,
    });
    assert.equal(r.supersededCount, 0);
  });

  it("self (same memoryId) → excluded from candidates", async () => {
    await resetDb();
    const eid = await insEntity("project", "p");
    const m1 = await insMemory(eid, "lonely");
    await setEmbedding(m1, sameVec());
    const r = await evaluateSupersessionFor(m1, {
      prisma,
      logger: silentLogger,
      clock: realClock,
    });
    assert.equal(r.supersededCount, 0);
  });
});
