// Embedding provider port. Every consumer (vector search filters,
// supersession, recall query embedding, the pending sweep) goes through this
// interface; vectors are stamped with the producing model/dimension so a
// future model change can be detected and re-indexed via `chest-index reembed`.

import { resolveProvider } from "./registry.js";
import { validateEnv } from "../../utils/env.js";

export interface EmbeddingProvider {
  readonly id: string;
  /** Stored into memories.embedding_model; rows from other models are not searchable. */
  readonly model: string;
  /** Stored into memories.embedding_dim; must match for a row to be searchable. */
  readonly dim: number;
  /** Embed a search query. Returns null on any failure (graceful degrade to FTS). */
  embedQuery(text: string): Promise<number[] | null>;
  /** Embed document passages. Returns null on any failure (rows stay pending). */
  embedPassages(texts: string[]): Promise<number[][] | null>;
}

let override: EmbeddingProvider | undefined;

export function activeProvider(): EmbeddingProvider {
  if (override) return override;
  return resolveProvider(validateEnv().CHEST_EMBED_MODEL);
}

/** Test helper: override or reset the active provider. */
export function setActiveProviderForTest(p: EmbeddingProvider | undefined): void {
  override = p;
}
