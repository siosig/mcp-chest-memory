import { HandleChestRecallSearchStrategy } from "../search/chest-recall-search-strategy.js";
import type { MemorySearchStrategy } from "../search/memory-search-strategy.js";
import type { RecallRequest, RecallResult, RecallServicePort } from "./types.js";

export class ChestRecallServiceAdapter implements RecallServicePort {
  constructor(private readonly searchStrategy: MemorySearchStrategy = new HandleChestRecallSearchStrategy()) {}

  async recall(request: RecallRequest): Promise<RecallResult> {
    return this.searchStrategy.search(request);
  }
}
