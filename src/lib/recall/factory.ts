import { ChestRecallServiceAdapter } from "./service.js";
import { HookRecallFacade } from "./hook-recall-facade.js";
import { HandleChestRecallSearchStrategy } from "../search/chest-recall-search-strategy.js";
import type { MemorySearchStrategy } from "../search/memory-search-strategy.js";
import type { RecallServicePort } from "./types.js";

export function createMemorySearchStrategy(): MemorySearchStrategy {
  return new HandleChestRecallSearchStrategy();
}

export function createRecallService(searchStrategy: MemorySearchStrategy = createMemorySearchStrategy()): RecallServicePort {
  return new ChestRecallServiceAdapter(searchStrategy);
}

export function createHookRecallFacade(recallService: RecallServicePort = createRecallService()): HookRecallFacade {
  return new HookRecallFacade(recallService);
}
