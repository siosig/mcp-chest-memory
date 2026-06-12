// T042 / SC-006 / FR-503,507: chest-index batch wiring + idempotency (model-free phases).
// Full `up`/`--all` (with supersess/reembed) needs the ONNX model — see supersession-batch.test.ts
// real-model case + quickstart §1. Here we verify activation+decay via the real CLI binary.
// spec 006: CLI is Prisma/MySQL — `--db` is gone; the child process inherits DATABASE_URL
// (set by `npm test`'s --env-file-if-exists=.env.test → chest_memory_dev).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { prisma, rawGet } from "../../src/lib/db/prisma-client.js";
import { resetDb, insEntity, insMemory } from "../helpers/db.js";

const CLI = fileURLToPath(new URL("../../src/cli/chest-index.ts", import.meta.url));

function runCli(args: string[]): { code: number; stdout: string; stderr: string } {
  // env is inherited → DATABASE_URL points at chest_memory_dev, same DB the test seeds.
  const r = spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], { encoding: "utf8" });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

async function seedV6(): Promise<void> {
  await resetDb();
  const eid = await insEntity("project", "batch");
  const now = Math.floor(Date.now() / 1000);
  await insMemory(eid, "fresh memory", { layer: "learning", importance: 0.5, createdAt: now, lastAccessedAt: now });
  await insMemory(eid, "stale ctx", {
    layer: "context",
    importance: 0.4,
    createdAt: now - 86400 * 40,
    lastAccessedAt: now - 86400 * 40,
    expiresAt: now - 1000,
  }); // expired
}

const count = async (sql: string): Promise<number> => {
  const r = await rawGet<{ c: number }>(prisma, sql);
  return r!.c;
};

test("up --activation persists scores; exit 0", async () => {
  await seedV6();
  const r = runCli(["up", "--activation"]);
  assert.equal(r.code, 0, r.stderr);
  const scored = await count("SELECT COUNT(*) c FROM memories WHERE activation_score IS NOT NULL");
  assert.ok(scored >= 2, "activation_score persisted for all memories");
});

test("up --decay is idempotent: 2nd run archives 0 new; only batch events accrue (SC-006/FR-207)", async () => {
  await seedV6();
  assert.equal(runCli(["up", "--decay"]).code, 0);
  const archivedAfter1 = await count("SELECT COUNT(*) c FROM memories WHERE archived_at IS NOT NULL");

  assert.equal(runCli(["up", "--decay"]).code, 0);
  const archivedAfter2 = await count("SELECT COUNT(*) c FROM memories WHERE archived_at IS NOT NULL");
  const batchEvents = await count("SELECT COUNT(*) c FROM events WHERE kind='decay_batch_completed'");

  assert.equal(archivedAfter2, archivedAfter1, "2nd decay archives nothing new");
  assert.equal(batchEvents, 2, "two decay_batch_completed events");
});

test("up --check is a full dry-run (no model, no writes), exit 0", async () => {
  await seedV6();
  const before = await count("SELECT COUNT(*) c FROM memories WHERE archived_at IS NOT NULL");

  const r = runCli(["up", "--check"]);
  assert.equal(r.code, 0, r.stderr);

  const after = await count("SELECT COUNT(*) c FROM memories WHERE archived_at IS NOT NULL");
  const events = await count("SELECT COUNT(*) c FROM events");
  assert.equal(after, before, "--check must not archive");
  assert.equal(events, 0, "--check must not write events");
});
