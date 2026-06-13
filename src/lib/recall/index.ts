export type { RecallRequest, RecallResult, RecalledMemorySummary, RecallServicePort } from "./types.js";
export { ChestRecallServiceAdapter } from "./service.js";
export { HookRecallFacade } from "./hook-recall-facade.js";
export { createMemorySearchStrategy, createRecallService, createHookRecallFacade } from "./factory.js";
