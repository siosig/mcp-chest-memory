// BGE-M3 embedding provider (BAAI/bge-m3 via Xenova ONNX).
// Unlike E5-family models, BGE-M3 uses CLS pooling and requires no
// query/passage prefix. Dimension: 1024.

import type { EmbeddingProvider } from "./provider.js";
import { modelCacheDir } from "../../utils/env.js";
import { logger } from "../../utils/logger.js";

export const BGE_M3_MODEL_ID = "Xenova/bge-m3";
export const BGE_M3_EMBEDDING_DIM = 1024;

interface FeatureExtractor {
  (texts: string[], opts: { pooling: "cls"; normalize: boolean }): Promise<{
    tolist(): number[][];
  }>;
}

let extractorPromise: Promise<FeatureExtractor | null> | undefined;

function getExtractor(): Promise<FeatureExtractor | null> {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      try {
        const { pipeline, env } = await import("@huggingface/transformers");
        env.cacheDir = modelCacheDir();
        const pipe = await pipeline("feature-extraction", BGE_M3_MODEL_ID, { dtype: "q8" });
        return pipe as unknown as FeatureExtractor;
      } catch (e) {
        logger.warn(
          { err: e instanceof Error ? e.message : String(e) },
          "bge-m3 model unavailable (offline before first download?); rows stay pending",
        );
        return null;
      }
    })();
  }
  return extractorPromise;
}

// Same hard cap as local-provider: prevents OOM on large batches.
const MAX_INFERENCE_BATCH = 16;

async function embed(texts: string[]): Promise<number[][] | null> {
  const extractor = await getExtractor();
  if (!extractor) return null;
  try {
    const all: number[][] = [];
    for (let i = 0; i < texts.length; i += MAX_INFERENCE_BATCH) {
      const chunk = texts.slice(i, i + MAX_INFERENCE_BATCH);
      const output = await extractor(chunk, { pooling: "cls", normalize: true });
      const vectors = output.tolist();
      if (!Array.isArray(vectors) || vectors.length !== chunk.length) return null;
      all.push(...vectors);
    }
    return all;
  } catch (e) {
    logger.warn({ err: e instanceof Error ? e.message : String(e) }, "bge-m3 inference failed");
    return null;
  }
}

export const bgeM3Provider: EmbeddingProvider = {
  id: "bge-m3",
  model: BGE_M3_MODEL_ID,
  dim: BGE_M3_EMBEDDING_DIM,
  async embedQuery(text: string): Promise<number[] | null> {
    const vectors = await embed([text]);
    return vectors?.[0] ?? null;
  },
  async embedPassages(texts: string[]): Promise<number[][] | null> {
    if (texts.length === 0) return [];
    return embed(texts);
  },
};

/** Warm up (and thereby download) the bge-m3 model. Used by chest-fetch-model. */
export async function warmupBgeM3(): Promise<boolean> {
  const vec = await bgeM3Provider.embedQuery("warmup");
  return Array.isArray(vec) && vec.length === BGE_M3_EMBEDDING_DIM;
}
