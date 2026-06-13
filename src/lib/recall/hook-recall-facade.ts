import type { NormalizedHookRecallRequest, HookRecallResponse } from "../../schemas/hook-recall.js";
import type { RecallServicePort, RecalledMemorySummary } from "./types.js";
import { HOOK_RECALL_UNTRUSTED_NOTICE, projectMatches, toHookRecalledMemory } from "./hook-recall-projection.js";

export class HookRecallFacade {
  constructor(private readonly recallService: RecallServicePort) {}

  async recall(request: NormalizedHookRecallRequest): Promise<HookRecallResponse> {
    const perLayerLimit = Math.max(1, request.limit);
    const results = await Promise.all(
      request.layers.map((layer) =>
        this.recallService.recall({
          query: request.query,
          layer,
          limit: perLayerLimit,
          max_tokens: request.max_tokens,
          offset: 0,
          mark_accessed: false,
          include_archived: false,
          include_superseded: false,
          ignore_decay: false,
          snippet_mode: true,
          snippet_window: 240,
        }),
      ),
    );

    const seen = new Map<number, RecalledMemorySummary>();
    for (const result of results) {
      for (const memory of result.memories) {
        if (!projectMatches(memory, request.project)) continue;
        const current = seen.get(memory.id);
        if (!current || memory.composite > current.composite) seen.set(memory.id, memory);
      }
    }

    const memories = Array.from(seen.values())
      .sort((left, right) => right.composite - left.composite)
      .slice(0, request.limit)
      .map(toHookRecalledMemory);

    return { ok: true, notice: HOOK_RECALL_UNTRUSTED_NOTICE, memories };
  }
}
