// Embedding provider port. The active provider is selected once per process
// from CHEST_EMBEDDING_PROVIDER; every consumer (vector search filters,
// supersession, recall query embedding, the pending sweep) goes through this
// interface so that providers can be swapped by configuration alone.

import { validateEnv } from "../../utils/env.js";
import { localProvider } from "./local-provider.js";
import { geminiProvider } from "./gemini-provider.js";

export interface EmbeddingProvider {
  readonly id: "local" | "gemini";
  /** Stored into memories.embedding_model; rows from other models are not searchable. */
  readonly model: string;
  /** Stored into memories.embedding_dim; must match for a row to be searchable. */
  readonly dim: number;
  /** Embed a search query. Returns null on any failure (graceful degrade to FTS). */
  embedQuery(text: string): Promise<number[] | null>;
  /** Embed document passages. Returns null on any failure (rows stay pending). */
  embedPassages(texts: string[]): Promise<number[][] | null>;
}

let cached: EmbeddingProvider | undefined;

export function activeProvider(): EmbeddingProvider {
  if (!cached) {
    cached = validateEnv().CHEST_EMBEDDING_PROVIDER === "gemini" ? geminiProvider : localProvider;
  }
  return cached;
}

/** Test helper: override or reset the active provider. */
export function setActiveProviderForTest(p: EmbeddingProvider | undefined): void {
  cached = p;
}
