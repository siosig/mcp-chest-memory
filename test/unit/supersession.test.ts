// T028 / FR-304: cosine similarity + supersede helper + batch detection (injected embedder).
import { test } from "node:test";
import assert from "node:assert/strict";
import { cosineSim, supersede, runSupersessPhase, type EmbedFn } from "../../src/lib/supersession.js";
import { prisma, rawGet } from "../../src/lib/db/prisma-client.js";
import { resetDb, insEntity, insMemory } from "../helpers/db.js";

// Deterministic fake embedder: "config*" → one direction, everything else → orthogonal.
const fakeEmbed: EmbedFn = async (texts) =>
  texts.map((t) => (t.toLowerCase().includes("config") ? [1, 0, 0] : [0, 1, 0]));

test("cosineSim: identical=1, orthogonal=0, opposite=-1", () => {
  assert.ok(Math.abs(cosineSim([1, 0], [1, 0]) - 1) < 1e-9);
  assert.ok(Math.abs(cosineSim([1, 0], [0, 1])) < 1e-9);
  assert.ok(Math.abs(cosineSim([1, 0], [-1, 0]) + 1) < 1e-9);
});

test("supersede archives old, sets superseded_by_id, records event, idempotent", async () => {
  await resetDb();
  const eid = await insEntity("project", "sup");
  const oldId = await insMemory(eid, "old");
  const newId = await insMemory(eid, "new");
  assert.equal(await supersede(oldId, newId, 0.92, "auto"), true);
  const row = await rawGet<{
    archived_at: number | null;
    superseded_by_id: number | null;
    supersession_confidence: number | null;
  }>(prisma, "SELECT archived_at, superseded_by_id, supersession_confidence FROM memories WHERE id=?", oldId);
  assert.ok(row!.archived_at != null);
  assert.equal(row!.superseded_by_id, newId);
  assert.equal(row!.supersession_confidence, 0.92);
  assert.equal(await supersede(oldId, newId, 0.92, "auto"), false); // idempotent
  const ev = await rawGet<{ c: number }>(prisma, "SELECT COUNT(*) c FROM events WHERE kind='memory_superseded'");
  assert.equal(ev!.c, 1);
});

test("runSupersessPhase: newer memory supersedes similar older one; unrelated kept", async () => {
  await resetDb();
  const eid = await insEntity("project", "sup");
  const now = Math.floor(Date.now() / 1000);
  const m1 = await insMemory(eid, "config is a.yml", { createdAt: now - 100 });
  const m2 = await insMemory(eid, "config is b.toml", { createdAt: now });
  const m3 = await insMemory(eid, "weather is sunny", { createdAt: now - 50 });

  const r = await runSupersessPhase(fakeEmbed, { now });
  assert.equal(r.embedded, 3);
  assert.ok(r.superseded >= 1);

  const g = (id: number) =>
    rawGet<{ archived_at: number | null; superseded_by_id: number | null; embedding: string | null }>(
      prisma,
      "SELECT archived_at, superseded_by_id, embedding FROM memories WHERE id=?",
      id,
    );
  assert.ok((await g(m1))!.archived_at != null, "older config memory superseded");
  assert.equal((await g(m1))!.superseded_by_id, m2);
  assert.equal((await g(m2))!.archived_at, null, "newer memory stays active");
  assert.equal((await g(m3))!.archived_at, null, "unrelated memory kept");
  assert.ok((await g(m2))!.embedding != null, "embeddings persisted");

  // idempotent: re-run embeds nothing, supersedes nothing
  const r2 = await runSupersessPhase(fakeEmbed, { now });
  assert.equal(r2.embedded, 0);
  assert.equal(r2.superseded, 0);
});
