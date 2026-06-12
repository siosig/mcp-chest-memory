// Optional embedding provider backed by the Gemini Embedding API.
// Single-shot embeddings (queries, the pending sweep, reembedding) go through
// embedContent here; large backfills are handled by the batch state machine
// (submit/fetch/ingest/reclaim driven by `chest-index cycle`).

import type { EmbeddingProvider } from "./provider.js";
import { l2norm } from "./gemini-client.js";
import { GEMINI_MODEL_ID, GEMINI_EMBEDDING_DIM } from "./config.js";
import { logger } from "../../utils/logger.js";

/** Minimal surface of @google/genai used for single-shot embedding (test-injectable). */
export interface SingleEmbedClient {
  models: {
    embedContent(args: {
      model: string;
      contents: string;
      config?: { outputDimensionality?: number; taskType?: string };
    }): Promise<{ embeddings?: Array<{ values?: number[] }> }>;
  };
}

// The SDK is imported lazily so that local-provider deployments never load it.
let cachedClient: SingleEmbedClient | null | undefined;

async function getClient(): Promise<SingleEmbedClient | null> {
  if (cachedClient !== undefined) return cachedClient;
  if (!process.env.GEMINI_API_KEY) {
    cachedClient = null;
    return null;
  }
  try {
    const mod = (await import("@google/genai")) as {
      GoogleGenAI: new (opts: Record<string, never>) => SingleEmbedClient;
    };
    cachedClient = new mod.GoogleGenAI({});
  } catch (e) {
    logger.warn(
      { err: e instanceof Error ? e.message : String(e) },
      "failed to load @google/genai; gemini embedding unavailable",
    );
    cachedClient = null;
  }
  return cachedClient;
}

export async function geminiEmbedSingle(
  text: string,
  taskType: "RETRIEVAL_QUERY" | "RETRIEVAL_DOCUMENT",
  injectedClient?: SingleEmbedClient,
): Promise<number[] | null> {
  const client = injectedClient ?? (await getClient());
  if (!client) return null;
  try {
    const r = await client.models.embedContent({
      model: GEMINI_MODEL_ID,
      contents: text,
      config: {
        outputDimensionality: GEMINI_EMBEDDING_DIM,
        taskType,
      },
    });
    const vec = r?.embeddings?.[0]?.values;
    if (!Array.isArray(vec) || vec.length !== GEMINI_EMBEDDING_DIM) {
      logger.warn(
        { len: Array.isArray(vec) ? vec.length : "n/a" },
        "gemini embedding: unexpected vector shape",
      );
      return null;
    }
    return l2norm(vec);
  } catch (e) {
    logger.warn(
      { err: e instanceof Error ? e.message : String(e) },
      "gemini embedContent failed, returning null",
    );
    return null;
  }
}

export const geminiProvider: EmbeddingProvider = {
  id: "gemini",
  model: GEMINI_MODEL_ID,
  dim: GEMINI_EMBEDDING_DIM,
  async embedQuery(text: string): Promise<number[] | null> {
    return geminiEmbedSingle(text, "RETRIEVAL_QUERY");
  },
  async embedPassages(texts: string[]): Promise<number[][] | null> {
    const out: number[][] = [];
    for (const t of texts) {
      const vec = await geminiEmbedSingle(t, "RETRIEVAL_DOCUMENT");
      if (!vec) return null;
      out.push(vec);
    }
    return out;
  },
};
