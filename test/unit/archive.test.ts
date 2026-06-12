// T022 / FR-202,205,209: archive transition helper.
import { test } from "node:test";
import assert from "node:assert/strict";
import { archiveMemory, archiveMemories } from "../../src/lib/archive.js";
import { prisma, rawAll } from "../../src/lib/db/prisma-client.js";
import { resetDb, insEntity, insMemory } from "../helpers/db.js";

async function eventCount(kind: string): Promise<number> {
  const rows = await rawAll<{ c: number }>(prisma, "SELECT COUNT(*) c FROM events WHERE kind=?", kind);
  return rows[0].c;
}

test("archiveMemory sets archived_at, returns true once, records event", async () => {
  await resetDb();
  const eid = await insEntity("project", "a");
  const id = await insMemory(eid, "x");
  assert.equal(await archiveMemory(id, "forget"), true);
  const rows = await rawAll<{ archived_at: number | null }>(
    prisma,
    "SELECT archived_at FROM memories WHERE id=?",
    id,
  );
  assert.ok(rows[0].archived_at != null);
  assert.equal(await eventCount("memory_archived"), 1);
});

test("archiveMemory is idempotent (second call returns false, no double event) — FR-209", async () => {
  await resetDb();
  const eid = await insEntity("project", "a");
  const id = await insMemory(eid, "x");
  await archiveMemory(id, "forget");
  assert.equal(await archiveMemory(id, "forget"), false);
  assert.equal(await eventCount("memory_archived"), 1);
});

test("archive never physically deletes: row still present after archive", async () => {
  await resetDb();
  const eid = await insEntity("project", "a");
  const id = await insMemory(eid, "x");
  await archiveMemory(id, "dropped");
  const rows = await rawAll<{ id: number }>(prisma, "SELECT id FROM memories WHERE id=?", id);
  assert.ok(rows.length > 0, "row must still exist (archive-first)");
});

test("archiveMemories archives many, reason maps to correct event kind", async () => {
  await resetDb();
  const eid = await insEntity("project", "a");
  const ids = [await insMemory(eid, "x"), await insMemory(eid, "x"), await insMemory(eid, "x")];
  const n = await archiveMemories(ids, "expired");
  assert.equal(n, 3);
  assert.equal(await eventCount("memory_expired"), 3);
});
