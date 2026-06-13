// Client-side embedding helper for remote mode.
//
// When CHEST_MODE=remote and the server reports `server_has_embedder=false`,
// the client computes vectors locally with the active provider (bge-m3 by
// default) and pushes them back via POST /memories/:id/embedding. This
// module isolates the "model not yet downloaded" trap (memory id 5138) by
// returning a typed error instead of throwing, so callers can surface a
// friendly fix_hint ("Run: chest-index fetch-model") without try/catch noise.

import { activeProvider } from "./provider.js";

export interface ClientEmbedError {
  error: "MODEL_CACHE_MISSING" | "EMPTY_INPUT" | "PROVIDER_FAILED";
  message: string;
}

export type ClientEmbedResult = Float32Array | ClientEmbedError;

function isCacheMissingError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  // transformers.js / @huggingface/hub variants for "model missing on disk":
  return (
    /ENOENT/i.test(msg) ||
    /No such file/i.test(msg) ||
    /Could not (locate|load|find)/i.test(msg) ||
    /model\.onnx/i.test(msg) && /not (found|exist)/i.test(msg)
  );
}

/**
 * Embed a single text on the client side.
 * @returns Float32Array vector on success, or a typed ClientEmbedError otherwise.
 */
export async function embedTextClient(text: string): Promise<ClientEmbedResult> {
  if (!text || text.trim().length === 0) {
    return { error: "EMPTY_INPUT", message: "text_for_embedding is empty" };
  }
  const provider = activeProvider();
  let vectors: number[][] | null;
  try {
    vectors = await provider.embedPassages([text]);
  } catch (e) {
    if (isCacheMissingError(e)) {
      return {
        error: "MODEL_CACHE_MISSING",
        message:
          "Embedding model is not cached locally. Run: chest-index fetch-model",
      };
    }
    return {
      error: "PROVIDER_FAILED",
      message: e instanceof Error ? e.message : String(e),
    };
  }
  if (!vectors || !vectors[0]) {
    // Provider's contract: returns null when the model is unavailable.
    return {
      error: "MODEL_CACHE_MISSING",
      message:
        "Embedding provider returned no vector (model likely not downloaded). Run: chest-index fetch-model",
    };
  }
  return Float32Array.from(vectors[0]);
}

/** True when the result indicates the model cache is missing. */
export function isModelCacheMissing(r: ClientEmbedResult): boolean {
  return !(r instanceof Float32Array) && r.error === "MODEL_CACHE_MISSING";
}
