// Acceptance tests for vector path production wiring and per-path normalised scoring.
// (a) kill switch off → embed function never called; legacy behaviour preserved
// (b) timeout → null; recall continues with FTS only (fail-open)
// (c) bad response (dimension mismatch) → skip
// (d) minCos filter rejects low-similarity vector hits
// (e) empty query (entity_name only) → vector path not executed
// (f) injected embedQuery (opts.embedQuery) takes precedence over production default
// (g) production default without injection → graceful degrade when API key absent
// (h) [US2] vector-only relevance monotonically tracks similarity; fixed floor 0.5 removed; breakdown extended
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { handleChestRecall } from "../../src/mcp/tools/chest-recall.js";
import { embedQueryWithTimeout, embedQueryOnce } from "../../src/lib/embedding/recall-embed.js";
import { prisma, rawRun } from "../../src/lib/db/prisma-client.js";
import { resetDb, insEntity, insMemory } from "../helpers/db.js";
import { setActiveProviderForTest } from "../../src/lib/embedding/provider.js";
import { geminiProvider } from "../../src/lib/embedding/gemini-provider.js";

// These fixtures store 768-dim gemini vectors; pin the matching provider so
// the (model, dim) searchable filter behaves as the assertions expect.
setActiveProviderForTest(geminiProvider);


const DIM = 768;

function makeVec(seed: number): number[] {
  const v = new Array<number>(DIM);
  let s = seed;
  for (let i = 0; i < DIM; i++) {
    s = (s * 1103515245 + 12345) | 0;
    v[i] = ((s >>> 0) % 10000) / 10000 - 0.5;
  }
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
}

/** Build an L2-normalised vector with the specified cosine to base using Gram-Schmidt. */
function makeVecWithCos(base: number[], cos: number, seed: number): number[] {
  const r = makeVec(seed);
  const dot = r.reduce((s, x, i) => s + x * base[i], 0);
  const orthRaw = r.map((x, i) => x - dot * base[i]);
  const n = Math.hypot(...orthRaw);
  const orth = orthRaw.map((x) => x / n);
  const sin = Math.sqrt(1 - cos * cos);
  return base.map((x, i) => cos * x + sin * orth[i]);
}

async function markDone(memoryId: number, vec: number[]): Promise<void> {
  await rawRun(
    prisma,
    "UPDATE memories SET embedding=?, embedding_dim=?, embedding_status='done', embedding_model='gemini-embedding-001' WHERE id=?",
    JSON.stringify(vec),
    vec.length,
    memoryId,
  );
}

const ENV_KEYS = [
  "CHEST_RECALL_VECTOR_ENABLED",
  "CHEST_RECALL_EMBED_TIMEOUT_MS",
  "CHEST_RECALL_W_VEC",
  "CHEST_RECALL_VECTOR_MIN_COS",
  "GEMINI_API_KEY",
] as const;
const savedEnv = new Map<string, string | undefined>();

describe("recall vector wiring + path-normalised scoring", () => {
  beforeEach(async () => {
    for (const k of ENV_KEYS) savedEnv.set(k, process.env[k]);
    await resetDb();
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      const v = savedEnv.get(k);
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("(a) kill switch off → embed function never called; legacy behaviour preserved", async () => {
    process.env.CHEST_RECALL_VECTOR_ENABLED = "false";
    const eid = await insEntity("project", "wiring");
    const m1 = await insMemory(eid, "kill switch verification target");
    await markDone(m1, makeVec(1));

    let called = 0;
    const res = JSON.parse(
      await handleChestRecall({ query: "verification" } as never, {
        embedQuery: async () => {
          called++;
          return makeVec(1);
        },
      }),
    );
    assert.equal(res.ok, true);
    assert.equal(called, 0, "embed function must not be called when vector is disabled");
    const target = res.memories.find((m: any) => m.id === m1);
    assert.ok(target, "FTS hit expected");
    assert.ok(!target.match_reasons.includes("content_match_vector"));
  });

  it("(b) timeout → null; recall continues with FTS only (fail-open)", async () => {
    const never = {
      models: { embedContent: () => new Promise<never>(() => {}) },
    };
    const t0 = Date.now();
    const vec = await embedQueryWithTimeout("query", 100, { client: never });
    assert.equal(vec, null);
    assert.ok(Date.now() - t0 < 3000, "must cut off near the timeoutMs value");
  });

  it("(c) bad response (dimension mismatch or empty) → null; vector path skipped", async () => {
    const short = {
      models: { embedContent: async () => ({ embeddings: [{ values: [0.1, 0.2] }] }) },
    };
    assert.equal(await embedQueryOnce("q", { client: short }), null);
    const empty = {
      models: { embedContent: async () => ({}) },
    };
    assert.equal(await embedQueryOnce("q", { client: empty }), null);
  });

  it("(d) vector hits below minCos threshold are excluded from candidates", async () => {
    process.env.CHEST_RECALL_VECTOR_MIN_COS = "0.55";
    const eid = await insEntity("project", "wiring");
    const queryVec = makeVec(42);
    // content unrelated to query "zzznohit" → FTS will never match
    const strong = await insMemory(eid, "強い関連の記憶ノードA");
    const weak = await insMemory(eid, "弱い関連の記憶ノードB");
    await markDone(strong, makeVecWithCos(queryVec, 0.9, 7));
    await markDone(weak, makeVecWithCos(queryVec, 0.2, 8));

    const res = JSON.parse(
      await handleChestRecall({ query: "zzznohit" } as never, {
        embedQuery: async () => queryVec,
      }),
    );
    const ids = res.memories.map((m: any) => m.id);
    assert.ok(ids.includes(strong), "cos 0.9 ≥ threshold → included");
    assert.ok(!ids.includes(weak), "cos 0.2 < threshold → excluded");
  });

  it("(e) empty query (effectively entity_name only) → vector path not executed", async () => {
    // query is required (minLength 1) in the zod schema, so truly absent cannot reach here.
    // Validate the defensive guard (do not embed when args.query is falsy) using an empty string.
    const eid = await insEntity("project", "wiring-entity");
    await insMemory(eid, "entity only recall");

    let called = 0;
    const res = JSON.parse(
      await handleChestRecall({ query: "", entity_name: "wiring-entity" } as never, {
        embedQuery: async () => {
          called++;
          return makeVec(1);
        },
      }),
    );
    assert.equal(res.ok, true);
    assert.equal(called, 0, "embed must not be called when query content is absent");
  });

  it("(f)+(g) injected embedQuery takes precedence; without injection, production default degrades gracefully when API key absent", async () => {
    delete process.env.GEMINI_API_KEY; // makes production default return null immediately
    const eid = await insEntity("project", "wiring");
    const m1 = await insMemory(eid, "default wiring degrade target");
    const targetVec = makeVec(5);
    await markDone(m1, targetVec);

    // with injection: fake is used → vector hit (injection takes precedence)
    const injected = JSON.parse(
      await handleChestRecall({ query: "zzznohit" } as never, {
        embedQuery: async () => targetVec,
      }),
    );
    const hit = injected.memories.find((m: any) => m.id === m1);
    assert.ok(hit?.match_reasons.includes("content_match_vector"), "injected fake causes vector hit");

    // without injection: production default → no GEMINI_API_KEY → null → FTS-only succeeds
    const bare = JSON.parse(await handleChestRecall({ query: "degrade" } as never));
    assert.equal(bare.ok, true);
    const ftsHit = bare.memories.find((m: any) => m.id === m1);
    assert.ok(ftsHit, "FTS hit (recall always succeeds)");
    assert.ok(!ftsHit.match_reasons.includes("content_match_vector"));
  });

  it("(h) [US2] vector-only relevance monotonically tracks similarity; no fixed floor at 0.5", async () => {
    const eid = await insEntity("project", "wiring");
    const queryVec = makeVec(42);
    const high = await insMemory(eid, "類似度の高い記憶エントリ甲"); // high-similarity fixture
    const mid = await insMemory(eid, "類似度が中位の記憶エントリ乙");  // mid-similarity fixture
    const low = await insMemory(eid, "類似度の低い記憶エントリ丙");   // low-similarity fixture
    await markDone(high, makeVecWithCos(queryVec, 0.95, 11));
    await markDone(mid, makeVecWithCos(queryVec, 0.8, 12));
    await markDone(low, makeVecWithCos(queryVec, 0.65, 13));

    const res = JSON.parse(
      await handleChestRecall({ query: "zzznohit" } as never, {
        embedQuery: async () => queryVec,
      }),
    );
    const byId = new Map(res.memories.map((m: any) => [m.id, m]));
    const h = byId.get(high) as any;
    const m = byId.get(mid) as any;
    const l = byId.get(low) as any;
    assert.ok(h && m && l, "all 3 records must vector-hit");

    // breakdown extension: vector_cos / vector_norm must be present
    for (const x of [h, m, l]) {
      assert.equal(typeof x.score_breakdown.vector_cos, "number");
      assert.equal(typeof x.score_breakdown.vector_norm, "number");
    }
    // monotonic link to cos (SC-005): cos order = relevance order. Min-Max → max=1, min=0
    assert.ok(
      h.score_breakdown.relevance > m.score_breakdown.relevance &&
        m.score_breakdown.relevance > l.score_breakdown.relevance,
      "relevance must monotonically track cosine similarity",
    );
    assert.equal(h.score_breakdown.relevance, 1, "highest vector-only → vecNorm=1");
    assert.equal(l.score_breakdown.relevance, 0, "lowest vector-only → vecNorm=0 (no floor at 0.5)");
    // relevance ∈ [0,1]
    for (const x of [h, m, l]) {
      assert.ok(x.score_breakdown.relevance >= 0 && x.score_breakdown.relevance <= 1);
    }
    // composite structure invariant: reconstructed base×decay must match composite (rounding error tolerated)
    for (const x of [h, m, l]) {
      const b = x.score_breakdown;
      const base = 0.45 * b.relevance + 0.25 * b.heat + 0.15 * b.momentum + 0.15 * b.importance;
      const expected = base * b.activation * b.ttl_penalty * b.supersession_penalty;
      assert.ok(Math.abs(x.composite - expected) < 0.02, `composite structure preserved (got ${x.composite}, want ~${expected})`);
    }
  });
});
