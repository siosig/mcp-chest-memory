import { handleChestRecall, type HandleChestRecallOptions } from "../../mcp/tools/chest-recall.js";
import type { RecallRequest, RecallResult } from "../recall/types.js";
import type { MemorySearchStrategy } from "./memory-search-strategy.js";

export class HandleChestRecallSearchStrategy implements MemorySearchStrategy {
  constructor(private readonly options: HandleChestRecallOptions = {}) {}

  async search(request: RecallRequest): Promise<RecallResult> {
    const json = await handleChestRecall(request, this.options);
    return JSON.parse(json) as RecallResult;
  }
}
