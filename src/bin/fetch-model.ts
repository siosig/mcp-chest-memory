#!/usr/bin/env node
// Prefetch / warm up the active embedding model so that runtime is fully
// offline afterwards. Idempotent: if the model is already cached this
// finishes in a few seconds without network access.
// Model is determined by CHEST_EMBED_MODEL (default: Xenova/bge-m3).
// When CHEST_RERANK_ENABLED=true, also prefetches CHEST_RERANK_MODEL.
//
// Exit codes: 0 = model ready, 1 = model could not be loaded.
//
// Usage:
//   chest-fetch-model                    prefetch activeProvider().model
//   chest-fetch-model --model <model-id> prefetch a specific model

import { activeProvider } from "../lib/embedding/provider.js";
import { modelCacheDir, validateEnv } from "../utils/env.js";
import { logger } from "../utils/logger.js";

function parseArgs(): { model?: string } {
  const argv = process.argv.slice(2);
  const out: { model?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--model" && argv[i + 1]) {
      out.model = argv[++i];
    }
  }
  return out;
}

const args = parseArgs();
const env = validateEnv();

// Override activeProvider for a single prefetch if --model is specified.
if (args.model) {
  process.env.CHEST_EMBED_MODEL = args.model;
}

const provider = activeProvider();

process.stderr.write(`[chest] preparing embedding model ${provider.model}\n`);
process.stderr.write(`[chest] cache directory: ${modelCacheDir()}\n`);

// Warm up by running a single inference. The model files are downloaded if not cached.
const testVec = await provider.embedQuery("warmup");
if (!Array.isArray(testVec) || testVec.length !== provider.dim) {
  process.stderr.write(
    `[chest] FAILED: model could not be downloaded/loaded. ` +
      `Check network connectivity, or rerun later — memories are still saved ` +
      `and will be embedded once the model is available.\n`,
  );
  process.exit(1);
}
process.stderr.write(`[chest] model ready (dim=${provider.dim})\n`);

// Optionally prefetch reranker model.
if (env.CHEST_RERANK_ENABLED) {
  process.stderr.write(`[chest] preparing reranker ${env.CHEST_RERANK_MODEL}\n`);
  try {
    const { pipeline, env: hfEnv } = await import("@huggingface/transformers");
    hfEnv.cacheDir = modelCacheDir();
    await pipeline("text-classification", env.CHEST_RERANK_MODEL, {
      dtype: "q4",
    } as Record<string, unknown>);
    process.stderr.write(`[chest] reranker ready\n`);
  } catch (e: unknown) {
    logger.warn({ err: e instanceof Error ? e.message : String(e) }, "reranker prefetch failed");
    process.stderr.write(`[chest] reranker prefetch failed (non-fatal): ${(e as Error).message}\n`);
  }
} else {
  process.stderr.write(
    `[chest] reranker disabled (set CHEST_RERANK_ENABLED=true to prefetch)\n`,
  );
}

process.exit(0);
