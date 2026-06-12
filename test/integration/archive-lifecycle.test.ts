// T023 / US2 Acceptance #1-7 / SC-002: forget / consolidate / decay all archive,
// never physically delete. No memory row is ever removed.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { handleChestForget } from "../../src/mcp/tools/chest-forget.js";
import { consolidate } from "../../src/lib/consolidate.js";
import { runDecayPhase } from "../../src/lib/decay.js";
import { handleChestRecall } from "../../src/mcp/tools/chest-recall.js";
import { prisma, rawGet } from "../../src/lib/db/prisma-client.js";
import { resetDb, insEntity, insMemory } from "../helpers/db.js";

const STUB_SERVER = {} as unknown as Server; // non-interactive forget never touches it

async function rowCount(): Promise<number> {
  const r = await rawGet<{ c: number }>(prisma, "SELECT COUNT(*) c FROM memories");
  return r!.c;
}
const archivedAt = (id: number) =>
  rawGet<{ archived_at: number | null }>(prisma, "SELECT archived_at FROM memories WHERE id=?", id);

test("forget(id) archives instead of deleting; row survives; recall recovers via include_archived", async () => {
  await resetDb();
  const eid = await insEntity("project", "lifecycle");
  const id = await insMemory(eid, "forget-target deploy");
  const before = await rowCount();

  const res = JSON.parse(
    await handleChestForget({ memory_id: id, dry_run: false, interactive: false } as never, STUB_SERVER),
  );
  assert.equal(res.ok, true);

  // not deleted — row still present, archived_at set
  const row = await archivedAt(id);
  assert.ok(row, "row must still exist");
  assert.ok(row!.archived_at != null, "archived_at must be set");
  assert.equal(await rowCount(), before, "COUNT must be unchanged (no physical delete)");

  // default recall excludes; include_archived recovers
  const def = JSON.parse(
    await handleChestRecall({ query: "deploy", entity_name: "lifecycle", mark_accessed: false } as never),
  );
  assert.ok(!def.memories.some((m: any) => m.id === id), "archived excluded by default");
  const inc = JSON.parse(
    await handleChestRecall({
      query: "deploy",
      entity_name: "lifecycle",
      include_archived: true,
      mark_accessed: false,
    } as never),
  );
  assert.ok(inc.memories.some((m: any) => m.id === id), "archived recoverable");
});

test("forget protected/pinned still preserved (spec 001 guard maintained)", async () => {
  await resetDb();
  const eid = await insEntity("project", "lifecycle");
  const cav = await insMemory(eid, "do not lose", { layer: "realize" });
  const res = JSON.parse(
    await handleChestForget({ memory_id: cav, dry_run: false, interactive: false } as never, STUB_SERVER),
  );
  assert.equal(res.ok, false);
  assert.equal(res.preserved, true);
  assert.equal((await archivedAt(cav))!.archived_at, null, "protected realize must not be archived");
});

test("consolidate archives cold cluster originals; adds learning; replaced_ids point to archived rows", async () => {
  await resetDb();
  const eid = await insEntity("project", "lifecycle");
  const old = Math.floor(Date.now() / 1000) - 86400 * 30; // 30d ago → cold
  const ids: number[] = [];
  for (const i of [1, 2, 3]) {
    ids.push(
      await insMemory(eid, `cold observation ${i}`, {
        layer: "implementation",
        importance: 0.4,
        createdAt: old,
        lastAccessedAt: old,
        accessCount: 0,
        // consolidate targets only embedding_status='done' (prevents archiving unembedded memories)
        embeddingStatus: "done",
      }),
    );
  }
  const before = await rowCount();

  const r = await consolidate({ scope: "all" });
  assert.ok(r.clustersCompressed >= 1, "should compress a cluster");

  // originals archived (not deleted)
  for (const id of ids) {
    const row = await archivedAt(id);
    assert.ok(row, `original ${id} must still exist`);
    assert.ok(row!.archived_at != null, `original ${id} must be archived`);
  }
  // a learning summary was added → COUNT grew, never shrank
  assert.ok((await rowCount()) >= before, "COUNT must not decrease");

  // replaced_ids in audit point to archived ids
  const audit = await rawGet<{ replaced_ids: string }>(prisma, "SELECT replaced_ids FROM consolidations LIMIT 1");
  const replaced = JSON.parse(audit!.replaced_ids) as number[];
  for (const id of replaced) {
    assert.ok((await archivedAt(id))!.archived_at != null, "replaced_ids must reference archived rows");
  }
});

test("runDecayPhase archives TTL-expired; idempotent on re-run", async () => {
  await resetDb();
  const eid = await insEntity("project", "lifecycle");
  const now = Math.floor(Date.now() / 1000);
  // decay only TTL-expires memories with embedding_status='done'
  const expId = await insMemory(eid, "stale ctx", { layer: "context", expiresAt: now - 1000, embeddingStatus: "done" });
  const before = await rowCount();

  const r1 = await runDecayPhase({ now });
  assert.ok(r1.expired >= 1);
  assert.ok((await archivedAt(expId))!.archived_at != null, "expired memory archived");
  assert.equal(await rowCount(), before, "no physical delete");

  // idempotent: second run archives nothing new
  const r2 = await runDecayPhase({ now });
  assert.equal(r2.expired, 0, "re-run archives 0 (FR-207)");
  const ev = await rawGet<{ c: number }>(
    prisma,
    "SELECT COUNT(*) c FROM events WHERE kind='decay_batch_completed'",
  );
  assert.equal(ev!.c, 2, "two batch-completed events");
});
