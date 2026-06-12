// T014 / FR-104: composite = base_v5 × activation × ttl_penalty × supersession_penalty.
// Two memories with identical base attributes differ only by decay factors → the ratio
// of their composites must equal the product of those factors.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleChestRecall } from "../../src/mcp/tools/chest-recall.js";
import { resetDb, insEntity, insMemory } from "../helpers/db.js";

test("composite ratio equals product of decay factors (0.5×0.5×0.5 = 0.125)", async () => {
  await resetDb();
  const eid = await insEntity("project", "rank");
  const full = await insMemory(eid, "ranking apple", {
    accessCount: 3,
    activationScore: 1.0,
    ttlPenalty: 1.0,
    supersessionPenalty: 1.0,
  });
  const decayed = await insMemory(eid, "ranking banana", {
    accessCount: 3,
    activationScore: 0.5,
    ttlPenalty: 0.5,
    supersessionPenalty: 0.5,
  });

  const res = JSON.parse(
    await handleChestRecall({ query: "ranking", entity_name: "rank", mark_accessed: false } as never),
  );
  const byId = new Map(res.memories.map((m: any) => [m.id, m.composite]));
  const cFull = byId.get(full) as number;
  const cDecayed = byId.get(decayed) as number;
  assert.ok(cFull > 0 && cDecayed > 0);
  const ratio = cDecayed / cFull;
  assert.ok(Math.abs(ratio - 0.125) < 0.02, `ratio ${ratio} should be ~0.125`);
});
