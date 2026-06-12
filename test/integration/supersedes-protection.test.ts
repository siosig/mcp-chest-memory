// supersedes protection (High-2). A supersedes list must not archive protected
// (realize), pinned (importance>=0.9), or goal memories; unprotected cross-entity
// targets are archived.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { resetDb, insEntity, insMemory } from "../helpers/db.js";
import { prisma, rawGet } from "../../src/lib/db/prisma-client.js";
import { handleChestRemember } from "../../src/mcp/tools/chest-remember.js";

async function archivedAt(id: number): Promise<number | null> {
  const r = await rawGet<{ archived_at: number | null }>(
    prisma,
    "SELECT archived_at FROM memories WHERE id = ?",
    id,
  );
  return r?.archived_at ?? null;
}

describe("chest_remember supersedes protection", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("does not archive a protected realize target; reports it skipped", async () => {
    const e = await insEntity("project", "alpha");
    const realizeId = await insMemory(e, "pain lesson", { layer: "realize", protected: 1 });
    const res = JSON.parse(
      await handleChestRemember({
        entity_name: "alpha",
        entity_kind: "project",
        layer: "learning",
        content: "replacement insight",
        supersedes: [realizeId],
      } as never),
    );
    assert.equal(res.ok, true);
    assert.equal(await archivedAt(realizeId), null, "realize must stay active");
    assert.deepEqual(res.skipped_protected, [realizeId]);
    assert.equal(res.superseded, undefined);
  });

  it("does not archive a pinned (importance>=0.9) target", async () => {
    const e = await insEntity("project", "alpha");
    const pinnedId = await insMemory(e, "critical", { importance: 0.95 });
    const res = JSON.parse(
      await handleChestRemember({
        entity_name: "alpha",
        entity_kind: "project",
        layer: "learning",
        content: "new",
        supersedes: [pinnedId],
      } as never),
    );
    assert.equal(await archivedAt(pinnedId), null);
    assert.deepEqual(res.skipped_protected, [pinnedId]);
  });

  it("archives an unprotected cross-entity target", async () => {
    const e1 = await insEntity("project", "alpha");
    const e2 = await insEntity("project", "beta");
    const oldId = await insMemory(e2, "stale note", { layer: "learning", importance: 0.4 });
    const res = JSON.parse(
      await handleChestRemember({
        entity_name: "alpha",
        entity_kind: "project",
        layer: "learning",
        content: "supersedes across entity",
        supersedes: [oldId],
      } as never),
    );
    assert.ok(res.superseded.includes(oldId), "unprotected target archived");
    assert.notEqual(await archivedAt(oldId), null);
  });
});
