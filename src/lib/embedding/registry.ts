// Provider registry: maps model IDs to EmbeddingProvider implementations.
// CHEST_EMBED_MODEL selects the active provider at runtime.

import type { EmbeddingProvider } from "./provider.js";
import { bgeM3Provider } from "./bge-m3-provider.js";
import { localProvider } from "./local-provider.js";
import { logger } from "../../utils/logger.js";

const PROVIDERS: Record<string, EmbeddingProvider> = {
  "Xenova/bge-m3": bgeM3Provider,
  "Xenova/multilingual-e5-small": localProvider,
};

/**
 * Resolve a provider by model ID. Falls back to bge-m3 with a warning
 * if the requested ID is not registered.
 */
export function resolveProvider(modelId: string): EmbeddingProvider {
  const provider = PROVIDERS[modelId];
  if (!provider) {
    logger.warn(
      { modelId, available: Object.keys(PROVIDERS) },
      "CHEST_EMBED_MODEL not in registry; falling back to bge-m3",
    );
    return bgeM3Provider;
  }
  return provider;
}

/** List all registered provider model IDs. */
export function listProviderIds(): string[] {
  return Object.keys(PROVIDERS);
}
