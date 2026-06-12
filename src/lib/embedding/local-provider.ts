// Default embedding provider: a small multilingual model executed locally
// via transformers.js (ONNX, CPU). No API key required; after the model has
// been downloaded once (tools/install.sh prefetches it) everything runs
// fully offline. E5-family models require the "query: " / "passage: "
// prefixes for asymmetric retrieval.

import type { EmbeddingProvider } from "./provider.js";
import { modelCacheDir } from "../../utils/env.js";
import { logger } from "../../utils/logger.js";

export const LOCAL_MODEL_ID = "Xenova/multilingual-e5-small";
export const LOCAL_EMBEDDING_DIM = 384;

interface FeatureExtractor {
  (texts: string[], opts: { pooling: "mean"; normalize: boolean }): Promise<{
    tolist(): number[][];
  }>;
}

let extractorPromise: Promise<FeatureExtractor | null> | undefined;

function getExtractor(): Promise<FeatureExtractor | null> {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      try {
        const { pipeline, env } = await import("@huggingface/transformers");
        // Keep model files under the chest data directory instead of the
        // global HF cache, so uninstall.sh can remove everything in one place.
        env.cacheDir = modelCacheDir();
        const pipe = await pipeline("feature-extraction", LOCAL_MODEL_ID, { dtype: "q8" });
        return pipe as unknown as FeatureExtractor;
      } catch (e) {
        logger.warn(
          { err: e instanceof Error ? e.message : String(e) },
          "local embedding model unavailable (offline before first download?); rows stay pending",
        );
        return null;
      }
    })();
  }
  return extractorPromise;
}

// Hard cap on texts per ONNX inference call. Transformer attention buffers
// scale with batch × seq², so an unbounded batch can exhaust process memory:
// the bootstrap backfill once passed ~5k texts in a single call and ground the
// machine into swap until the process was killed.
const MAX_INFERENCE_BATCH = 16;

async function embed(texts: string[]): Promise<number[][] | null> {
  const extractor = await getExtractor();
  if (!extractor) return null;
  try {
    const all: number[][] = [];
    for (let i = 0; i < texts.length; i += MAX_INFERENCE_BATCH) {
      const chunk = texts.slice(i, i + MAX_INFERENCE_BATCH);
      // pooling=mean + normalize=true yields L2-normalized sentence vectors.
      const output = await extractor(chunk, { pooling: "mean", normalize: true });
      const vectors = output.tolist();
      if (!Array.isArray(vectors) || vectors.length !== chunk.length) return null;
      all.push(...vectors);
    }
    return all;
  } catch (e) {
    logger.warn(
      { err: e instanceof Error ? e.message : String(e) },
      "local embedding inference failed",
    );
    return null;
  }
}

export const localProvider: EmbeddingProvider = {
  id: "local",
  model: LOCAL_MODEL_ID,
  dim: LOCAL_EMBEDDING_DIM,
  async embedQuery(text: string): Promise<number[] | null> {
    const vectors = await embed([`query: ${text}`]);
    return vectors?.[0] ?? null;
  },
  async embedPassages(texts: string[]): Promise<number[][] | null> {
    if (texts.length === 0) return [];
    return embed(texts.map((t) => `passage: ${t}`));
  },
};

/** Warm up (and thereby download) the local model. Used by chest-fetch-model. */
export async function warmupLocalModel(): Promise<boolean> {
  const vec = await localProvider.embedQuery("warmup");
  return Array.isArray(vec) && vec.length === LOCAL_EMBEDDING_DIM;
}
