// T013 / FR-102, FR-109, research.md D14: ACT-R Base-Level Activation.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  baseLevelActivation,
  normalizeActivation,
  computeTtlPenalty,
  runActivationPhase,
} from "../../src/lib/activation.js";
import { prisma, rawAll } from "../../src/lib/db/prisma-client.js";
import { resetDb, insEntity, insMemory, insAccessLog } from "../helpers/db.js";

test("baseLevelActivation: more recent access yields higher activation", () => {
  const recent = baseLevelActivation([3600]); // 1h ago
  const old = baseLevelActivation([3600 * 24 * 30]); // 30d ago
  assert.ok(recent > old, `recent (${recent}) should exceed old (${old})`);
});

test("baseLevelActivation: more accesses (frequency burst) yields higher activation", () => {
  const once = baseLevelActivation([86400]);
  const many = baseLevelActivation([86400, 90000, 100000, 120000, 150000]);
  assert.ok(many > once);
});

test("baseLevelActivation: empty access list is -Infinity", () => {
  assert.equal(baseLevelActivation([]), Number.NEGATIVE_INFINITY);
});

test("normalizeActivation: bounded in (0,1) and monotonic in B", () => {
  const lo = normalizeActivation(-12);
  const hi = normalizeActivation(0);
  assert.ok(lo > 0 && lo < 1 && hi > 0 && hi < 1);
  assert.ok(hi > lo);
  assert.equal(normalizeActivation(Number.NEGATIVE_INFINITY), 0);
});

test("computeTtlPenalty: 1.0 when no expiry or not expired, <1 after expiry", () => {
  const now = 1_000_000;
  assert.equal(computeTtlPenalty(null, now), 1.0);
  assert.equal(computeTtlPenalty(now + 1000, now), 1.0);
  assert.ok(computeTtlPenalty(now - 86400 * 30, now) < 1.0);
});

test("runActivationPhase: persists scores; old << new; pinned stays 1.0", async () => {
  await resetDb();
  const now = Math.floor(Date.now() / 1000);
  const eid = await insEntity("project", "p");
  const mOld = await insMemory(eid, "old", { createdAt: now - 86400 * 60, lastAccessedAt: now - 86400 * 60 });
  const mNew = await insMemory(eid, "new", { createdAt: now - 86400, lastAccessedAt: now });
  const mPin = await insMemory(eid, "pinned", {
    layer: "realize",
    importance: 0.95,
    createdAt: now - 86400 * 60,
    lastAccessedAt: now - 86400 * 60,
  });

  await insAccessLog(mOld, now - 86400 * 60); // single old access
  for (const d of [1, 2, 3, 4, 5]) await insAccessLog(mNew, now - (86400 * d) / 5); // recent burst

  const r = await runActivationPhase({ now });
  assert.ok(r.updated >= 3);

  const get = async (id: number): Promise<number> => {
    const rows = await rawAll<{ activation_score: number }>(
      prisma,
      "SELECT activation_score FROM memories WHERE id=?",
      id,
    );
    return rows[0].activation_score;
  };
  const sOld = await get(mOld);
  const sNew = await get(mNew);
  const sPin = await get(mPin);

  assert.ok(sNew > sOld, `new (${sNew}) should exceed old (${sOld})`);
  assert.ok(sOld <= sNew * 0.3, `old (${sOld}) should be <= 30% of new (${sNew})`);
  assert.equal(sPin, 1.0, "pinned/protected stays 1.0");

  // event recorded
  const ev = await rawAll<{ c: number }>(
    prisma,
    "SELECT COUNT(*) c FROM events WHERE kind='activation_batch_completed'",
  );
  assert.ok(ev[0].c >= 1);
});
