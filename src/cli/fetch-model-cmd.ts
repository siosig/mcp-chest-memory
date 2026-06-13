// Thin adapter that lets `chest-index fetch-model` (parsed in chest-index.ts)
// invoke the prefetch logic implemented in src/bin/fetch-model.ts without
// spawning a subprocess. Keeps the existing `chest-fetch-model` bin entry
// usable as a standalone tool while consolidating the implementation.

import { runFetchModel as runFetchModelImpl } from "../bin/fetch-model.js";

// Shape of the args object passed in by chest-index.ts. We only consume the
// flags relevant to fetch-model; unrelated fields are ignored.
interface FetchModelCliArgs {
  json?: boolean;
  reranker?: boolean;
  force?: boolean;
  modelId?: string;
}

export async function runFetchModel(args: FetchModelCliArgs): Promise<number> {
  return runFetchModelImpl({
    json: args.json === true,
    reranker: args.reranker === true,
    force: args.force === true,
    modelId: args.modelId && args.modelId.length > 0 ? args.modelId : undefined,
  });
}
