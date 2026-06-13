import { test } from "node:test";
import assert from "node:assert/strict";
import { HookRecallFacade } from "../../src/lib/recall/hook-recall-facade.js";
import type { RecallRequest, RecallResult, RecallServicePort } from "../../src/lib/recall/types.js";

function recallResult(layer: string, entityName: string, entityKind: string): RecallResult {
  return {
    ok: true,
    _notice: "data",
    count: 1,
    total_candidates: 1,
    offset: 0,
    has_more: false,
    search: "test",
    resolved_layer: layer,
    memories: [
      {
        id: layer === "realize" ? 1 : 2,
        entity: { id: 10, name: entityName, kind: entityKind, momentum: 0 },
        layer,
        content: `${layer} content`,
        importance: 0.8,
        pinned: false,
        heat: 0,
        band: "cold",
        composite: layer === "realize" ? 0.9 : 0.7,
        created_at: "1800000000",
        match_reasons: [],
        score_breakdown: {},
      },
    ],
  };
}

test("hook recall facade maps to non-mutating shared recall requests", async () => {
  const calls: RecallRequest[] = [];
  const service: RecallServicePort = {
    async recall(request: RecallRequest): Promise<RecallResult> {
      calls.push(request);
      return recallResult(request.layer ?? "learning", "mcp-chest-memory", "project");
    },
  };
  const facade = new HookRecallFacade(service);
  const response = await facade.recall({
    query: "remote recall",
    project: "mcp-chest-memory",
    layers: ["realize", "learning"],
    limit: 8,
    max_tokens: 1500,
  });

  assert.equal(response.memories.length, 2);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.mark_accessed, false);
    assert.equal(call.include_archived, false);
    assert.equal(call.include_superseded, false);
    assert.equal(call.snippet_mode, true);
  }
});

test("hook recall facade can use an injected service and preserves projectless memories", async () => {
  const service: RecallServicePort = {
    async recall(request: RecallRequest): Promise<RecallResult> {
      return recallResult(request.layer ?? "learning", "global-rule", "concept");
    },
  };
  const facade = new HookRecallFacade(service);
  const response = await facade.recall({
    query: "global rule",
    project: "mcp-chest-memory",
    layers: ["learning"],
    limit: 8,
    max_tokens: 1500,
  });
  assert.equal(response.memories.length, 1);
  assert.equal(response.memories[0]?.project, "global-rule");
});
