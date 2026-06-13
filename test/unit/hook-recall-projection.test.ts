import { test } from "node:test";
import assert from "node:assert/strict";
import { projectMatches, toHookRecalledMemory } from "../../src/lib/recall/hook-recall-projection.js";
import type { RecalledMemorySummary } from "../../src/lib/recall/types.js";

function memory(overrides: Partial<RecalledMemorySummary> = {}): RecalledMemorySummary {
  return {
    id: 1,
    entity: { id: 10, name: "mcp-chest-memory", kind: "project", momentum: 0 },
    layer: "learning",
    content: "content",
    importance: 0.8,
    pinned: false,
    heat: 0,
    band: "cold",
    composite: 0.9,
    created_at: "1800000000",
    match_reasons: [],
    score_breakdown: {},
    ...overrides,
  };
}

test("hook recall projection bounds title and content", () => {
  const projected = toHookRecalledMemory(
    memory({
      entity: { id: 10, name: "x".repeat(200), kind: "project", momentum: 0 },
      content: "y".repeat(1000),
    }),
  );
  assert.ok(Array.from(projected.title).length <= 120);
  assert.ok(Array.from(projected.content).length <= 900);
  assert.equal(projected.score, 0.9);
  assert.match(projected.created_at, /^2027-/);
});

test("project matching allows current project and explicitly projectless memories", () => {
  assert.equal(projectMatches(memory(), "mcp-chest-memory"), true);
  assert.equal(projectMatches(memory(), "other-project"), false);
  assert.equal(
    projectMatches(memory({ entity: { id: 11, name: "global-rule", kind: "concept", momentum: 0 } }), "other-project"),
    true,
  );
});
