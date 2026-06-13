// Cross-encoder reranker using bge-reranker-v2-m3.
// Optional: disabled by default (CHEST_RERANK_ENABLED=false).
// Fail-open: if model load or inference exceeds CHEST_RERANK_TIMEOUT_MS, the
// original RRF-ranked list is returned unchanged.

import { validateEnv } from "../../utils/env.js";
import { logger } from "../../utils/logger.js";

export interface RerankCandidate {
  id: number;
  content: string;
}

type TextClassificationPipeline = (
  input: { text: string; text_pair: string } | Array<{ text: string; text_pair: string }>,
  options?: Record<string, unknown>,
) => Promise<Array<{ label: string; score: number }> | { label: string; score: number }>;

let pipelinePromise: Promise<TextClassificationPipeline | null> | undefined;

function loadReranker(modelId: string): Promise<TextClassificationPipeline | null> {
  if (!pipelinePromise) {
    pipelinePromise = (async (): Promise<TextClassificationPipeline | null> => {
      try {
        const { pipeline } = await import("@huggingface/transformers");
        const p = await pipeline("text-classification", modelId, {
          dtype: "q4",
        } as Record<string, unknown>);
        return p as unknown as TextClassificationPipeline;
      } catch (e) {
        logger.warn(
          { err: e instanceof Error ? e.message : String(e) },
          "reranker: failed to load model; reranking disabled",
        );
        return null;
      }
    })();
  }
  return pipelinePromise;
}

/** Reset reranker pipeline cache (for testing only). */
export function resetRerankerForTest(): void {
  pipelinePromise = undefined;
}

/**
 * Rerank candidates using the cross-encoder model.
 *
 * Returns the reranked list. If CHEST_RERANK_ENABLED=false, the model fails to
 * load, or inference exceeds CHEST_RERANK_TIMEOUT_MS, returns the original list
 * unchanged (fail-open).
 */
export async function rerank(
  query: string,
  candidates: RerankCandidate[],
): Promise<RerankCandidate[]> {
  const env = validateEnv();
  if (!env.CHEST_RERANK_ENABLED || candidates.length === 0) {
    return candidates;
  }

  const modelId = env.CHEST_RERANK_MODEL;
  const topN = Math.min(env.CHEST_RERANK_TOP_N, candidates.length);
  const timeoutMs = env.CHEST_RERANK_TIMEOUT_MS;

  const rerankedOrNull = await Promise.race([
    runRerank(query, candidates.slice(0, topN), modelId),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);

  if (rerankedOrNull === null) {
    logger.warn(
      { timeoutMs, model: modelId },
      "reranker: inference timed out; returning original ranking",
    );
    return candidates;
  }

  // Append any candidates beyond topN in their original order.
  const tail = candidates.slice(topN);
  return [...rerankedOrNull, ...tail];
}

async function runRerank(
  query: string,
  candidates: RerankCandidate[],
  modelId: string,
): Promise<RerankCandidate[] | null> {
  try {
    const pipe = await loadReranker(modelId);
    if (!pipe) return null;

    const inputs = candidates.map((c) => ({ text: query, text_pair: c.content }));
    const rawResults = await pipe(inputs);
    const results = Array.isArray(rawResults) ? rawResults : [rawResults];

    // Score map: higher is more relevant. bge-reranker outputs logits labeled
    // "LABEL_0" (irrelevant) and "LABEL_1" (relevant); use score of LABEL_1.
    const scored = candidates.map((c, i) => {
      const result = results[i];
      const score = result
        ? result.label === "LABEL_1"
          ? result.score
          : 1 - result.score
        : 0;
      return { candidate: c, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.candidate);
  } catch (e) {
    logger.warn(
      { err: e instanceof Error ? e.message : String(e) },
      "reranker: inference error; returning original ranking",
    );
    return null;
  }
}
