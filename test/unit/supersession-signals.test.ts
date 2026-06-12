// FR-311/312/313/314 (realize #4534 hardening): the 0.97 threshold alone is not
// enough — large entities like `workspace` (2,658 memories) accumulate near-duplicate
// JSON shapes that the e5 model rates high. These tests pin the guards:
//   - same-layer constraint
//   - JSON top-level shape match skip (FR-313)
//   - 90d time window + 200-peer cap (FR-314)
//   - regression of the #4534 mass-archive scenario (4128/4198 -> 0 with guards)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runSupersessPhase,
  structuralShapeKey,
  SUPERSEDE_THRESHOLD,
  SUPERSESS_TIME_WINDOW_SEC,
  type EmbedFn,
} from "../../src/lib/supersession.js";
import { prisma, rawGet } from "../../src/lib/db/prisma-client.js";
import { resetDb, insEntity, insMemory } from "../helpers/db.js";

// Highly similar embedder: every text gets the same vector. Without guards this
// would archive every older memory; the guards must intervene.
const fixedEmbed: EmbedFn = async (texts) => texts.map(() => [1, 0, 0]);

const archivedAt = (id: number) =>
  rawGet<{ archived_at: number | null }>(prisma, "SELECT archived_at FROM memories WHERE id=?", id);

test("threshold default is 0.97 (FR-311 / realize #4534-a)", () => {
  assert.equal(SUPERSEDE_THRESHOLD, 0.97);
});

test("structuralShapeKey: same JSON top-level keys → identical signature; text → null", () => {
  const a = structuralShapeKey('{"file":"a.ts","ops":"write","op_count":1}');
  const b = structuralShapeKey('{"op_count":2,"file":"b.ts","ops":"edit"}'); // key order differs
  assert.ok(a !== null);
  assert.equal(a, b);
  assert.equal(structuralShapeKey("plain text content"), null);
  assert.equal(structuralShapeKey("[1,2,3]"), null);
  assert.equal(structuralShapeKey("{}"), null); // empty object → null (no shape signal)
});

test("FR-312: peers restricted to SAME layer (cross-layer pair stays active)", async () => {
  await resetDb();
  const eid = await insEntity("project", "layer");
  const now = Math.floor(Date.now() / 1000);
  const learn = await insMemory(eid, "config is a.yml", { layer: "learning", createdAt: now - 100 });
  const ctx = await insMemory(eid, "config is a.yml", { layer: "context", createdAt: now });
  const r = await runSupersessPhase(fixedEmbed, { now });
  assert.equal(r.embedded, 2);
  assert.equal(r.compared, 0, "no cross-layer comparison happens");
  assert.equal((await archivedAt(learn))!.archived_at, null);
  assert.equal((await archivedAt(ctx))!.archived_at, null);
});

test("FR-313 / realize #4534-b: identical JSON shape pairs are skipped before cosine", async () => {
  await resetDb();
  const eid = await insEntity("project", "shape");
  const now = Math.floor(Date.now() / 1000);
  // The exact #4534 pattern: per-file edit logs sharing top-level keys.
  await insMemory(eid, '{"file":"a.ts","ops":"write","op_count":1,"sample_change":"WRITE(...)"}', {
    layer: "implementation",
    createdAt: now - 200,
  });
  await insMemory(eid, '{"file":"b.ts","ops":"edit","op_count":2,"sample_change":"EDIT(...)"}', {
    layer: "implementation",
    createdAt: now - 100,
  });
  await insMemory(eid, '{"file":"c.ts","ops":"write","op_count":1,"sample_change":"WRITE(...)"}', {
    layer: "implementation",
    createdAt: now,
  });

  const r = await runSupersessPhase(fixedEmbed, { now });
  assert.equal(r.embedded, 3);
  assert.ok(r.skippedByShape > 0, "shape guard triggered");
  assert.equal(r.compared, 0, "shape guard skips before cosine");
  assert.equal(r.superseded, 0, "no archives");
  const archived = await rawGet<{ c: number }>(
    prisma,
    "SELECT COUNT(*) c FROM memories WHERE archived_at IS NOT NULL",
  );
  assert.equal(archived!.c, 0);
});

test("FR-313 negative: distinct shapes still compared (and a true update still wins)", async () => {
  await resetDb();
  const eid = await insEntity("project", "shape-neg");
  const now = Math.floor(Date.now() / 1000);
  const old = await insMemory(eid, "Node version is 22", { layer: "learning", createdAt: now - 100 });
  const fresh = await insMemory(eid, "Node version is 24.14", { layer: "learning", createdAt: now });
  const r = await runSupersessPhase(fixedEmbed, { now });
  assert.equal(r.compared, 1, "non-JSON content is compared normally");
  assert.equal(r.superseded, 1, "newer wins at sim=1 ≥ 0.97");
  const oldRow = await rawGet<{ archived_at: number | null; superseded_by_id: number | null }>(
    prisma,
    "SELECT archived_at, superseded_by_id FROM memories WHERE id=?",
    old,
  );
  assert.ok(oldRow!.archived_at != null);
  assert.equal(oldRow!.superseded_by_id, fresh);
});

test("FR-314: peers older than the time window are excluded", async () => {
  await resetDb();
  const eid = await insEntity("project", "window");
  const now = Math.floor(Date.now() / 1000);
  // Old peer sits well outside the 90-day window.
  const ancient = await insMemory(eid, "ancient config note", {
    layer: "learning",
    createdAt: now - (SUPERSESS_TIME_WINDOW_SEC + 86_400),
  });
  const fresh = await insMemory(eid, "fresh config note", { layer: "learning", createdAt: now });
  const r = await runSupersessPhase(fixedEmbed, { now });
  assert.equal(r.embedded, 2);
  assert.equal(r.compared, 0, "ancient peer is out of window");
  assert.equal(r.superseded, 0);
  assert.equal((await archivedAt(ancient))!.archived_at, null, "ancient memory survives");
  assert.equal((await archivedAt(fresh))!.archived_at, null);
});

test("FR-314: peer count cap limits comparisons per candidate", async () => {
  await resetDb();
  const eid = await insEntity("project", "limit");
  const now = Math.floor(Date.now() / 1000);
  // Pre-embed 50 peers so they are NOT re-processed in this phase (only the
  // candidate is). The cap then governs how many of those 50 a single
  // candidate compares against.
  const vec = JSON.stringify([1, 0, 0]);
  for (let i = 0; i < 50; i++) {
    await insMemory(eid, `peer ${i}`, {
      layer: "learning",
      createdAt: now - 1000 + i,
      embedding: vec,
      embeddingModel: "test/model",
    });
  }
  await insMemory(eid, "candidate", { layer: "learning", createdAt: now });
  const r = await runSupersessPhase(fixedEmbed, { now, peerLimit: 10 });
  assert.equal(r.embedded, 1, "only candidate was embedded in this phase");
  assert.equal(r.compared, 10, "exactly peerLimit comparisons made");
});

test("realize #4534 regression: identical-shape file-edit logs do NOT mass-archive", async () => {
  await resetDb();
  const eid = await insEntity("project", "4534");
  const now = Math.floor(Date.now() / 1000);
  const N = 100; // scaled-down stand-in for the workspace=2,658 catastrophe
  for (let i = 0; i < N; i++) {
    await insMemory(eid, JSON.stringify({ file: `f${i}.ts`, ops: "write", op_count: 1, sample_change: "..." }), {
      layer: "implementation",
      createdAt: now - (N - i) * 60,
    });
  }
  const r = await runSupersessPhase(fixedEmbed, { now });
  assert.equal(r.embedded, N);
  assert.equal(r.superseded, 0, "must not archive (shape guard saved the day)");
  assert.equal(r.compared, 0, "everything skipped by shape match");
  const active = await rawGet<{ c: number }>(
    prisma,
    "SELECT COUNT(*) c FROM memories WHERE archived_at IS NULL",
  );
  assert.equal(active!.c, N, "all rows still active");
});
