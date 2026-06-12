// T043 / SC-011 + T047 / SC-005 (sanity). spec 006: SQLite WAL → MySQL/InnoDB MVCC.
// InnoDB MVCC lets the MCP read path (recall) coexist with a batch writer
// (runActivationPhase) on a single Prisma pool — recall stays correct under load.
// Full 10k-scale p95 is verified in the user's environment (quickstart §7); here we
// assert correctness + a generous, LAN-aware latency bound.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runActivationPhase } from "../../src/lib/activation.js";
import { handleChestRecall } from "../../src/mcp/tools/chest-recall.js";
import { prisma } from "../../src/lib/db/prisma-client.js";
import { resetDb, insEntity } from "../helpers/db.js";

async function seed(n: number): Promise<void> {
  await resetDb();
  const eid = await insEntity("project", "load");
  const now = Math.floor(Date.now() / 1000);
  const data = Array.from({ length: n }, (_, i) => ({
    entityId: BigInt(eid),
    layer: "learning",
    content: `deploy config note number ${i} alpha bravo`,
    importance: 0.5,
    createdAt: BigInt(now - i * 60),
    lastAccessedAt: BigInt(now - i * 60),
  }));
  await prisma.memory.createMany({ data });
}

test("InnoDB MVCC: recall stays correct while a batch writer (runActivationPhase) runs concurrently (SC-011)", async () => {
  await seed(200);
  let errors = 0;
  // Interleave: each round fires an activation batch and 20 concurrent recalls
  // against the shared Prisma pool. MVCC must keep readers consistent + error-free.
  for (let round = 0; round < 5; round++) {
    const writer = runActivationPhase({ force: true });
    const readers = Array.from({ length: 20 }, async () => {
      try {
        const res = JSON.parse(
          await handleChestRecall({ query: "deploy", entity_name: "load", mark_accessed: false } as never),
        );
        if (!res.ok || res.count === 0) errors++;
      } catch {
        errors++;
      }
    });
    await Promise.all([writer, ...readers]);
  }
  assert.equal(errors, 0, "no recall errors during concurrent batch writes");
});

test("recall latency sanity on 200 memories (generous LAN-aware bound; 10k target = quickstart §7)", async () => {
  await seed(200);
  await runActivationPhase({ force: true });
  const samples: number[] = [];
  for (let i = 0; i < 50; i++) {
    const t0 = process.hrtime.bigint();
    await handleChestRecall({ query: "deploy config", entity_name: "load", mark_accessed: false } as never);
    samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  samples.sort((a, b) => a - b);
  const p95 = samples[Math.floor(samples.length * 0.95)];
  // MySQL over LAN: each recall is several round-trips, so the bound is generous —
  // this is a no-pathology check, not the perf SLO (that is quickstart §7 on 10k).
  assert.ok(p95 < 1000, `recall p95 ${p95.toFixed(1)}ms should be reasonable on 200 memories (LAN)`);
});
