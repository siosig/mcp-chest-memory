#!/usr/bin/env node
// Prefetch / warm up the local embedding model so that runtime is fully
// offline afterwards. Idempotent: if the model is already cached this
// finishes in a few seconds without network access.
//
// Exit codes: 0 = model ready, 1 = model could not be loaded.

import { warmupLocalModel, LOCAL_MODEL_ID } from "../lib/embedding/local-provider.js";
import { modelCacheDir } from "../utils/env.js";

process.stderr.write(`[chest] preparing local embedding model ${LOCAL_MODEL_ID}\n`);
process.stderr.write(`[chest] cache directory: ${modelCacheDir()}\n`);

const ok = await warmupLocalModel();
if (!ok) {
  process.stderr.write(
    "[chest] FAILED: model could not be downloaded/loaded. " +
      "Check network connectivity, or rerun later — memories are still saved " +
      "and will be embedded once the model is available.\n",
  );
  process.exit(1);
}
process.stderr.write("[chest] model ready (embedding dimension verified)\n");
process.exit(0);
