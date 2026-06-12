// chest_forget sweep cap (High-4). An argument-less forget must archive at most
// CHEST_FORGET_SWEEP_CAP memories per call; protected/pinned rows are never swept;
// a second call drains the next batch.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { resetDb, insEntity, insMemory } from "../helpers/db.js";
import { FORGET_SWEEP_CAP } from "../../src/lib/embedding/config.js";
import { prisma, rawGet } from "../../src/lib/db/prisma-client.js";
import { handleChestForget } from "../../src/mcp/tools/chest-forget.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

const STUB = {} as unknown as Server;
const DAY = 86400;

async function archivedCount(): Promise<number> {
  const r = await rawGet<{ c: number }>(
    prisma,
    "SELECT COUNT(*) c FROM memories WHERE archived_at IS NOT NULL",
  );
  return r!.c;
}

describe("chest_forget sweep cap", () => {
  let protectedId: number;

  beforeEach(async () => {
    await resetDb();
    const e = await insEntity("project", "alpha");
    const now = Math.floor(Date.now() / 1000);
    // Seed CAP + 5 droppable memories: very old, low importance, no accesses → high risk.
    const old = now - 400 * DAY;
    for (let i = 0; i < FORGET_SWEEP_CAP + 5; i++) {
      await insMemory(e, `stale ${i}`, {
        layer: "context",
        importance: 0.2,
        createdAt: old,
        lastAccessedAt: old,
        accessCount: 0,
      });
    }
    // A protected memory in range must never be swept.
    protectedId = await insMemory(e, "pain", {
      layer: "realize",
      protected: 1,
      importance: 0.2,
      createdAt: old,
      lastAccessedAt: old,
    });
  });

  it("archives at most the cap and reports affected/remaining", async () => {
    const res = JSON.parse(await handleChestForget({} as never, STUB));
    assert.equal(res.ok, true);
    assert.equal(res.cap, FORGET_SWEEP_CAP);
    assert.equal(res.affected, FORGET_SWEEP_CAP, "exactly cap archived in one call");
    assert.equal(res.remaining, 5, "over-cap drop candidates left for next call");
    assert.equal(await archivedCount(), FORGET_SWEEP_CAP);

    // Protected memory never archived.
    const prot = await rawGet<{ archived_at: number | null }>(
      prisma,
      "SELECT archived_at FROM memories WHERE id = ?",
      protectedId,
    );
    assert.equal(prot!.archived_at, null);
  });

  it("a second call drains the remaining batch", async () => {
    await handleChestForget({} as never, STUB);
    const res2 = JSON.parse(await handleChestForget({} as never, STUB));
    assert.equal(res2.affected, 5, "second call archives the leftover 5");
    assert.equal(res2.remaining, 0);
    assert.equal(await archivedCount(), FORGET_SWEEP_CAP + 5);
  });
});
