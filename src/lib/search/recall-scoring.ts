// Per-path score normalization and fusion for the hybrid recall pipeline.
// Pure functions — no DB or I/O dependencies.
// Relevance integration uses RRF (Reciprocal Rank Fusion).

export interface RecallScoringConfig {
  /** CHEST_RECALL_VECTOR_ENABLED (default true). Set to false to disable the vector path entirely (kill switch). */
  vectorEnabled: boolean;
  /** CHEST_RECALL_EMBED_TIMEOUT_MS (default 3000). Timeout for query embedding retrieval. */
  embedTimeoutMs: number;
  /** CHEST_RECALL_W_VEC (default 0.5, clamped to [0,1]). w_fts is derived as 1 - wVec. */
  wVec: number;
  /** CHEST_RECALL_VECTOR_MIN_COS (default 0.55). Vector hits below this cosine threshold are excluded. */
  minCos: number;
  /** CHEST_RRF_K (default 60, clamped to [1,1000]). RRF rank smoothing constant. */
  rrfK: number;
}

const DEFAULT_EMBED_TIMEOUT_MS = 3000;
const DEFAULT_W_VEC = 0.5;
const DEFAULT_MIN_COS = 0.55;
export const DEFAULT_RRF_K = 60;

function parseBool(raw: string | undefined): boolean {
  if (raw === undefined || raw === "") return true;
  const v = raw.trim().toLowerCase();
  return v !== "false" && v !== "0";
}

function parseNum(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (Number.isNaN(n)) return fallback;
  // Out-of-range values are clamped rather than falling back to the default.
  return Math.min(max, Math.max(min, n));
}

/** Load config from env. `env` is injectable for tests (defaults to process.env). Invalid values fall back to defaults rather than failing startup. */
export function loadRecallScoringConfig(env: NodeJS.ProcessEnv = process.env): RecallScoringConfig {
  const timeoutRaw = env.CHEST_RECALL_EMBED_TIMEOUT_MS;
  const timeoutN = timeoutRaw === undefined || timeoutRaw === "" ? DEFAULT_EMBED_TIMEOUT_MS : Number(timeoutRaw);
  return {
    vectorEnabled: parseBool(env.CHEST_RECALL_VECTOR_ENABLED),
    embedTimeoutMs: Number.isNaN(timeoutN) || timeoutN <= 0 ? DEFAULT_EMBED_TIMEOUT_MS : timeoutN,
    wVec: parseNum(env.CHEST_RECALL_W_VEC, DEFAULT_W_VEC, 0, 1),
    minCos: parseNum(env.CHEST_RECALL_VECTOR_MIN_COS, DEFAULT_MIN_COS, -1, 1),
    rrfK: parseNum(env.CHEST_RRF_K, DEFAULT_RRF_K, 1, 1000),
  };
}

/** If the score span is below this epsilon, all candidates are treated as equal and receive 1.0 (prevents division by zero). */
const SPAN_EPSILON = 1e-6;

/**
 * Min-Max normalization for the vector search path.
 * Pass only hits that have already passed the cosine threshold filter (no noise in the population).
 * Monotonicity guaranteed: the ordering of scores equals the ordering of normalized values.
 */
export function normalizeVectorScores(
  hits: ReadonlyArray<{ id: number; score: number }>,
): Map<number, number> {
  const out = new Map<number, number>();
  if (hits.length === 0) return out;
  let min = Infinity;
  let max = -Infinity;
  for (const h of hits) {
    if (h.score < min) min = h.score;
    if (h.score > max) max = h.score;
  }
  const span = max - min;
  for (const h of hits) {
    out.set(h.id, span < SPAN_EPSILON ? 1.0 : (h.score - min) / span);
  }
  return out;
}

/** Neutral relevance used when neither path (FTS nor vector) produced a signal (e.g. LIKE-only hit). */
export const NEUTRAL_RELEVANCE = 0.5;

/**
 * Fuse FTS and vector normalized scores into a single relevance value. Four cases:
 * - Both non-null: (1-wVec)·ftsNorm + wVec·vecNorm
 * - ftsNorm only: ftsNorm  |  vecNorm only: vecNorm
 * - Both null: NEUTRAL_RELEVANCE
 * Output is in [0,1] when inputs are in [0,1]. No fixed floor for vector-only hits.
 */
export function integrateRelevance(
  ftsNorm: number | null,
  vecNorm: number | null,
  wVec: number,
): number {
  const w = Math.min(1, Math.max(0, wVec));
  if (ftsNorm != null && vecNorm != null) return (1 - w) * ftsNorm + w * vecNorm;
  if (ftsNorm != null) return ftsNorm;
  if (vecNorm != null) return vecNorm;
  return NEUTRAL_RELEVANCE;
}

// ---------------------------------------------------------------------------
// RRF (Reciprocal Rank Fusion)
// Recall relevance fusion has moved from the score-based integrateRelevance to
// the rank-based rrfScore. integrateRelevance is retained for test compatibility.
// ---------------------------------------------------------------------------

/**
 * RRF raw score: Σ_{path ∈ hit} 1 / (k + rank_path).
 * Ranks are 1-based; undefined means the path did not hit (the term is omitted).
 * Returns 0 when neither path hits (caller should treat as NEUTRAL_RELEVANCE).
 *
 * Guarantee: a row that is top-ranked in both paths (ranks a, b both roughly ≤ k)
 * always outscores a single-path #1 hit — 1/(k+a) + 1/(k+b) > 1/(k+1).
 * Rows ranked far below k in both paths score below a single-path #1 hit,
 * which correctly prioritises mutual agreement among high-ranking candidates.
 */
export function rrfScore(
  ftsRank: number | undefined,
  vecRank: number | undefined,
  k: number = DEFAULT_RRF_K,
): number {
  const kk = Math.max(1, k);
  let s = 0;
  if (ftsRank !== undefined && ftsRank >= 1) s += 1 / (kk + ftsRank);
  if (vecRank !== undefined && vecRank >= 1) s += 1 / (kk + vecRank);
  return s;
}

/**
 * Min-Max normalize RRF raw scores within the result set to a 0..1 relevance value.
 * Only rows with raw > 0 (actual hits) are included in the population; rows with
 * raw === 0 are excluded (caller assigns NEUTRAL_RELEVANCE).
 * A single hit or all-equal hits receive 1.0 (same convention as normalizeVectorScores).
 */
export function normalizeRrfScores(rawById: ReadonlyMap<number, number>): Map<number, number> {
  const out = new Map<number, number>();
  const hits = [...rawById.entries()].filter(([, v]) => v > 0);
  if (hits.length === 0) return out;
  let min = Infinity;
  let max = -Infinity;
  for (const [, v] of hits) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min;
  for (const [id, v] of hits) {
    out.set(id, span < SPAN_EPSILON ? 1.0 : (v - min) / span);
  }
  return out;
}
