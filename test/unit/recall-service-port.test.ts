import { test } from "node:test";
import assert from "node:assert/strict";
import { ChestRecallServiceAdapter } from "../../src/lib/recall/service.js";
import { HookRecallFacade } from "../../src/lib/recall/hook-recall-facade.js";
import type { MemorySearchStrategy } from "../../src/lib/search/memory-search-strategy.js";
import type { RecallRequest, RecallResult, RecallServicePort } from "../../src/lib/recall/types.js";

function resultFor(request: RecallRequest): RecallResult {
  return {
    ok: true,
    _notice: "data",
    count: 1,
    total_candidates: 1,
    offset: 0,
    has_more: false,
    search: "test",
    resolved_layer: request.layer ?? null,
    memories: [
      {
        id: 1,
        entity: { id: 1, name: "mcp-chest-memory", kind: "project", momentum: 0 },
        layer: request.layer ?? "learning",
        content: "shared recall port",
        importance: 0.8,
        pinned: false,
        heat: 0,
        band: "cold",
        composite: 0.9,
        created_at: "1800000000",
        match_reasons: [],
        score_breakdown: {},
      },
    ],
  };
}

test("ChestRecallServiceAdapter exposes the recall service port", () => {
  const service: RecallServicePort = new ChestRecallServiceAdapter();
  assert.equal(typeof service.recall, "function");
});

test("ChestRecallServiceAdapter delegates recall execution to an injected MemorySearchStrategy", async () => {
  const calls: RecallRequest[] = [];
  const strategy: MemorySearchStrategy = {
    async search(request: RecallRequest): Promise<RecallResult> {
      calls.push(request);
      return resultFor(request);
    },
  };
  const service: RecallServicePort = new ChestRecallServiceAdapter(strategy);
  const response = await service.recall({
    query: "strategy substitution",
    layer: "learning",
    max_tokens: 100,
    offset: 0,
    mark_accessed: false,
    include_archived: false,
    include_superseded: false,
    ignore_decay: false,
    snippet_mode: true,
    snippet_window: 240,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.query, "strategy substitution");
  assert.equal(response.memories[0]?.content, "shared recall port");
});

test("HookRecallFacade invokes RecallServicePort instead of owning a search path", async () => {
  const calls: RecallRequest[] = [];
  const service: RecallServicePort = {
    async recall(request: RecallRequest): Promise<RecallResult> {
      calls.push(request);
      return resultFor(request);
    },
  };
  const facade = new HookRecallFacade(service);
  await facade.recall({
    query: "shared recall",
    project: "mcp-chest-memory",
    layers: ["realize", "learning"],
    limit: 8,
    max_tokens: 1500,
  });
  assert.deepEqual(calls.map((call) => call.layer), ["realize", "learning"]);
  assert.equal(calls.every((call) => call.mark_accessed === false), true);
});
