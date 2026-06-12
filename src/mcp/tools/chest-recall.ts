import { prisma, rawAll, rawRun } from "../../lib/db/prisma-client.js";
import { ChestError } from "../../utils/errors.js";
import { selectWithinTokenBudget } from "../../lib/token-budget.js";
import { computeHeat } from "../../lib/heat-index.js";
import { refreshMomentumForEntity } from "../../lib/momentum.js";
import { resolveLayer } from "../../schemas/common.js";
import type { ChestRecallInput } from "../../schemas/chest-recall.js";
import { runVectorQuery } from "../../lib/search/vector-search.js";
import { embedQueryWithTimeout } from "../../lib/embedding/recall-embed.js";
import {
  loadRecallScoringConfig,
  normalizeVectorScores,
  rrfScore,
  normalizeRrfScores,
  NEUTRAL_RELEVANCE,
} from "../../lib/search/recall-scoring.js";
import { extractSnippet, DEFAULT_SNIPPET_WINDOW } from "../../lib/search/snippet.js";

// The query is embedded by the local model with a timeout and fail-open
// behavior: if the model is unavailable or the call times out, embedQuery
// returns null and recall gracefully degrades to FTS + LIKE only.
// Tests can inject a fake via `handleChestRecall(args, { embedQuery })`.
type EmbedQueryFn = (query: string) => Promise<number[] | null>;

const defaultEmbedQuery: EmbedQueryFn = (query) =>
  embedQueryWithTimeout(query, loadRecallScoringConfig().embedTimeoutMs);

interface RecallRow {
  id: number;
  entity_id: number;
  entity_name: string;
  entity_kind: string;
  momentum_score: number;
  layer: string;
  content: string;
  importance: number;
  created_at: number;
  last_accessed_at: number;
  access_count: number;
  bm25_score: number;
  protected?: number;
  // Persisted decay factors — read-only at recall time; written by the indexing batch job.
  archived_at: number | null;
  superseded_by_id: number | null;
  activation_score: number | null;
  ttl_penalty: number | null;
  supersession_penalty: number | null;
  activation_computed_at: number | null;
  // Only the IS NULL status of the embedding column is read for staleness checks; the full LONGTEXT is not fetched.
  embedding_is_null: number; // 1 = embedding not yet generated, 0 = generated (MySQL TinyInt 1/0)
  _via?: "fts" | "like" | "fts+like" | "vector" | "vector+fts" | "vector+like";
  // cosine similarity score from the vector path (0..1); undefined when the vector path was not used
  _vector_score?: number;
}

// Persisted decay columns are selected on every recall; decay values are never recomputed at query time.
// The embedding LONGTEXT column (~7 KB/row) is not fetched — only its IS NULL status is checked.
const V6_SELECT =
  "m.archived_at, m.superseded_by_id, m.activation_score, m.ttl_penalty, m.supersession_penalty, m.activation_computed_at, (m.embedding IS NULL) AS embedding_is_null";

// FTS5 trigram query builder. The trigram tokenizer matches 3-character
// substrings in any language (no morphological analyzer needed), but it
// cannot match terms shorter than 3 characters — those are dropped here and
// covered by the LIKE path instead. Each surviving term is double-quoted to
// neutralize FTS5 operators and the terms are OR-joined.
function toFtsQuery(raw: string): string {
  const terms = raw
    .replace(/["]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => Array.from(t).length >= 3);
  return terms.map((t) => `"${t}"`).join(" OR ");
}

// FTS5 search joined back to memories/entities. bm25() is "smaller is
// better", which the downstream scoring (relevance = 1 - (bm25-min)/span)
// expects as-is.
async function runFtsQuery(
  query: string,
  layer: string | undefined,
  limit: number,
  extraWhere: string,
): Promise<RecallRow[]> {
  let sql = `
    SELECT m.id, m.entity_id, e.name as entity_name, e.kind as entity_kind, e.momentum_score,
           m.layer, m.content, m.importance, m.created_at, m.last_accessed_at, m.access_count,
           m.protected, ${V6_SELECT},
           bm25(memories_fts) as bm25_score
    FROM memories_fts
    JOIN memories m ON m.id = memories_fts.rowid
    JOIN entities e ON e.id = m.entity_id
    WHERE memories_fts MATCH ?
  `;
  const params: unknown[] = [query];
  if (layer) {
    sql += " AND m.layer = ?";
    params.push(layer);
  }
  sql += extraWhere;
  sql += " ORDER BY bm25_score ASC LIMIT ?";
  params.push(limit);
  return rawAll<RecallRow>(prisma, sql, ...params);
}

async function runLikeQuery(
  query: string | undefined,
  entityName: string | undefined,
  layer: string | undefined,
  limit: number,
  extraWhere: string,
): Promise<RecallRow[]> {
  let sql = `
    SELECT m.id, m.entity_id, e.name as entity_name, e.kind as entity_kind, e.momentum_score,
           m.layer, m.content, m.importance, m.created_at, m.last_accessed_at, m.access_count,
           m.protected, ${V6_SELECT},
           0 as bm25_score
    FROM memories m
    JOIN entities e ON e.id = m.entity_id
    WHERE 1=1
  `;
  const params: unknown[] = [];
  if (entityName) {
    sql += " AND e.name LIKE ?";
    params.push(`%${entityName}%`);
  }
  if (layer) {
    sql += " AND m.layer = ?";
    params.push(layer);
  }
  if (query && !entityName) {
    sql += " AND (e.name LIKE ? OR m.content LIKE ?)";
    params.push(`%${query}%`, `%${query}%`);
  }
  sql += extraWhere;
  sql += " ORDER BY m.importance DESC, m.last_accessed_at DESC LIMIT ?";
  params.push(limit);
  return rawAll<RecallRow>(prisma, sql, ...params);
}

// Fetch full rows for vector hit IDs, returning the same column shape as FTS/LIKE queries
// so the downstream scoring functions can treat all search paths uniformly.
async function fetchRowsByIds(
  ids: number[],
  layer: string | undefined,
  extraWhere: string,
): Promise<RecallRow[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  let sql = `
    SELECT m.id, m.entity_id, e.name as entity_name, e.kind as entity_kind, e.momentum_score,
           m.layer, m.content, m.importance, m.created_at, m.last_accessed_at, m.access_count,
           m.protected, ${V6_SELECT},
           0 as bm25_score
    FROM memories m
    JOIN entities e ON e.id = m.entity_id
    WHERE m.id IN (${placeholders})
  `;
  const params: unknown[] = [...ids];
  if (layer) {
    sql += " AND m.layer = ?";
    params.push(layer);
  }
  sql += extraWhere;
  return rawAll<RecallRow>(prisma, sql, ...params);
}

const MOMENTUM_STALE_SECS = 3600;
const ACTIVATION_STALE_SECS = 3600; // FR-108: warn if activation older than 1h

async function refreshStaleMomentum(entityIds: number[]): Promise<void> {
  if (entityIds.length === 0) return;
  const unique = Array.from(new Set(entityIds));
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - MOMENTUM_STALE_SECS;
  const placeholders = unique.map(() => "?").join(",");
  const rows = await rawAll<{ id: number }>(
    prisma,
    `SELECT id FROM entities WHERE id IN (${placeholders}) AND (momentum_at IS NULL OR momentum_at < ?)`,
    ...unique,
    cutoff,
  );
  for (const r of rows) {
    try {
      await refreshMomentumForEntity(r.id);
    } catch {
      /* non-fatal */
    }
  }
}

// Hard safety cap so that an extremely large max_tokens value cannot cause MCP output to exceed
// the server's output limit. The cap is conservative enough that even worst-case token underestimates
// for multi-byte content remain well within bounds.
const SAFETY_CAP_TOKENS = 6000;

export interface HandleChestRecallOptions {
  /**
   * Function that produces a query embedding vector.
   * Returning null skips the vector search path and falls back to FTS + LIKE only.
   * Exposed so tests can inject a fake; the production default is `defaultEmbedQuery`.
   */
  embedQuery?: EmbedQueryFn;
}

export async function handleChestRecall(
  args: ChestRecallInput,
  opts: HandleChestRecallOptions = {},
): Promise<string> {
  const maxTokens = Math.max(100, args.max_tokens ?? 2000);
  // Truncation is based on actual token budget rather than a fixed-count estimate,
  // because per-memory token counts vary significantly with content length.
  // limit is the absolute hard ceiling on result count (default: schema maximum of 200).
  const hardLimit = args.limit !== undefined ? Math.max(1, Math.min(200, args.limit)) : 200;
  const offset = Math.max(0, args.offset ?? 0);
  const markAccessed = args.mark_accessed !== false;
  const ignoreDecay = args.ignore_decay === true;

  const layer = resolveLayer(args.layer);
  const band = args.band;

  // When ids are provided, skip query-based search and fetch those memories directly (always full content).
  // When neither query nor ids is provided, throw an input error.
  // The schema keeps ZodObject so the MCP SDK can introspect inputSchema; validation is done here instead.
  const idsMode = !!args.ids && args.ids.length > 0;
  // An empty-string query is allowed and falls through to LIKE-only mode (existing tests rely on this behavior).
  // The only case rejected here is when the query key itself is absent and ids is also absent.
  if (!idsMode && args.query == null) {
    throw new ChestError(
      "Either `query` or `ids` is required",
      "INVALID_INPUT",
      "Pass a free-text query, or pass ids: number[] to refetch full content of known memories.",
    );
  }
  // snippet_mode replaces each memory's content with a window around the query terms. Ignored when ids is set.
  const snippetMode = args.snippet_mode === true && !idsMode;
  const snippetWindow = args.snippet_window ?? DEFAULT_SNIPPET_WINDOW;
  const queryTerms = snippetMode ? (args.query ?? "").split(/\s+/).filter(Boolean) : [];

  // By default, exclude archived and superseded memories unless explicitly requested.
  let extraWhere = "";
  if (!args.include_superseded) extraWhere += " AND m.superseded_by_id IS NULL";
  if (!args.include_archived) {
    extraWhere += args.include_superseded
      ? " AND (m.archived_at IS NULL OR m.superseded_by_id IS NOT NULL)"
      : " AND m.archived_at IS NULL";
  }

  // Fetch more candidates than needed (3x the hard limit) so the token-budget filter has enough to choose from.
  const fetchLimit = Math.min(200, hardLimit) * 3 + offset;

  let rows: RecallRow[] = [];
  let searchMethod: "fts5" | "like" | "fts5+like" | "ids" = "like";

  const ftsQuery = idsMode ? "" : toFtsQuery(args.query ?? "");
  const canUseFts = !!ftsQuery && !args.entity_name;

  const seen = new Map<number, RecallRow>();
  // Per-path rank maps for RRF (1-based). Each path returns results in relevance-descending order
  // (FTS: bm25_score ASC; vector: cosine DESC), so the array index directly encodes rank.
  const ftsRankById = new Map<number, number>();
  const vecRankById = new Map<number, number>();

  if (idsMode) {
    // Direct SELECT by id. Layer / archived / superseded filters follow the same rules as other paths —
    // archived and superseded memories are excluded by default.
    const idRows = await fetchRowsByIds(args.ids!, layer, extraWhere);
    for (const r of idRows) seen.set(r.id, { ...r });
    searchMethod = "ids";
  } else if (canUseFts) {
    const ftsRows = await runFtsQuery(ftsQuery, layer, fetchLimit, extraWhere);
    const likeRows = await runLikeQuery(args.query, undefined, layer, fetchLimit, extraWhere);
    ftsRows.forEach((r, i) => ftsRankById.set(r.id, i + 1));
    for (const r of ftsRows) seen.set(r.id, { ...r, _via: "fts" });
    for (const r of likeRows) {
      const existing = seen.get(r.id);
      if (existing) {
        existing._via = "fts+like";
      } else {
        seen.set(r.id, { ...r, _via: "like" });
      }
    }
    if (ftsRows.length > 0 && likeRows.length > 0) searchMethod = "fts5+like";
    else if (ftsRows.length > 0) searchMethod = "fts5";
    else searchMethod = "like";
  } else {
    const likeRows = await runLikeQuery(args.query, args.entity_name, layer, fetchLimit, extraWhere);
    for (const r of likeRows) seen.set(r.id, { ...r, _via: "like" });
    searchMethod = "like";
  }

  // ----- Vector search path -----
  // If a query embedding is available, fetch vector top-k results and union them with the FTS/LIKE hits.
  // If embedding is unavailable (no API key, API error, or timeout), skip vector search entirely and
  // fall back gracefully to FTS + LIKE only. The vector path can also be disabled via
  // CHEST_RECALL_VECTOR_ENABLED=false.
  const scoringCfg = loadRecallScoringConfig();
  const embedFn = opts.embedQuery ?? defaultEmbedQuery;
  let queryVec: number[] | null = null;
  if (!idsMode && args.query && scoringCfg.vectorEnabled) {
    try {
      queryVec = await embedFn(args.query);
    } catch {
      queryVec = null;
    }
  }
  // Per-path normalized score map for vector hits. Empty when the vector path is not taken.
  let vecNormById = new Map<number, number>();
  if (queryVec && queryVec.length > 0) {
    const vectorHits = await runVectorQuery({
      queryVec,
      layer,
      topK: Math.min(200, fetchLimit),
      includeArchived: args.include_archived,
      includeSuperseded: args.include_superseded,
      minCos: scoringCfg.minCos,
    });
    vecNormById = normalizeVectorScores(vectorHits);
    vectorHits.forEach((h, i) => vecRankById.set(h.id, i + 1));
    if (vectorHits.length > 0) {
      const newIds = vectorHits.filter((h) => !seen.has(h.id)).map((h) => h.id);
      const newRows = await fetchRowsByIds(newIds, layer, extraWhere);
      const newRowById = new Map(newRows.map((r) => [r.id, r]));
      for (const h of vectorHits) {
        const existing = seen.get(h.id);
        if (existing) {
          // Already retrieved via FTS/LIKE — upgrade _via to indicate both paths matched.
          if (existing._via === "fts") existing._via = "vector+fts";
          else if (existing._via === "like") existing._via = "vector+like";
          else if (existing._via === "fts+like") existing._via = "vector+fts";
          existing._vector_score = h.score;
        } else {
          const fresh = newRowById.get(h.id);
          if (fresh) {
            seen.set(h.id, { ...fresh, _via: "vector", _vector_score: h.score });
          }
        }
      }
    }
  }

  rows = Array.from(seen.values());

  const now = Math.floor(Date.now() / 1000);

  await refreshStaleMomentum(rows.map((r) => r.entity_id));
  if (rows.length > 0) {
    const ids = Array.from(new Set(rows.map((r) => r.entity_id)));
    const ph = ids.map(() => "?").join(",");
    const fresh = await rawAll<{ id: number; momentum_score: number }>(
      prisma,
      `SELECT id, momentum_score FROM entities WHERE id IN (${ph})`,
      ...ids,
    );
    const byId = new Map(fresh.map((f) => [f.id, f.momentum_score]));
    for (const r of rows) r.momentum_score = byId.get(r.entity_id) ?? r.momentum_score;
  }

  // Relevance is computed with Reciprocal Rank Fusion (RRF), replacing score-based linear combination.
  // RRF is distribution-independent: results that rank highly in multiple paths naturally float to the top.
  // Scores are Min-Max normalized to 0..1 within the result set;
  // results that appear only via LIKE (no FTS or vector rank) receive a neutral relevance value.
  const rrfRawById = new Map<number, number>();
  for (const r of rows) {
    rrfRawById.set(r.id, rrfScore(ftsRankById.get(r.id), vecRankById.get(r.id), scoringCfg.rrfK));
  }
  const rrfNormById = normalizeRrfScores(rrfRawById);

  interface ScoredRow extends RecallRow {
    heat_score: number;
    heat_band: "hot" | "warm" | "cold" | "frozen";
    composite_score: number;
    relevance_score: number;
    _reasons: string[];
    _breakdown: {
      relevance: number;
      heat: number;
      momentum: number;
      importance: number;
      activation: number;
      ttl_penalty: number;
      supersession_penalty: number;
      activation_computed_at: number | null;
      // Present only for memories retrieved via the vector path.
      vector_cos?: number;
      vector_norm?: number;
      // Per-path RRF rank; omitted when the memory was not retrieved via that path.
      rrf_fts_rank?: number;
      rrf_vec_rank?: number;
    };
  }

  const scored: ScoredRow[] = rows.map((r) => {
    const daysSince = (now - r.last_accessed_at) / 86400;
    const heat = computeHeat({
      accessesLast30d: daysSince < 30 ? r.access_count : 0,
      accessesLast90d: daysSince < 90 ? r.access_count : 0,
      daysSinceLastAccess: daysSince,
      totalAccesses: r.access_count,
      baseImportance: r.importance,
    });

    // Use the RRF-normalized value as relevance. Memories only found via LIKE (no FTS or vector rank)
    // receive the neutral relevance value (0.5). vecNorm is kept for score_breakdown display only.
    const vecNorm = vecNormById.get(r.id) ?? null;
    const relevance = rrfNormById.get(r.id) ?? NEUTRAL_RELEVANCE;
    const heatNorm = heat.score / 100;
    const momNorm = Math.min(1, (r.momentum_score ?? 0) / 10);
    const importanceBoost = r.importance;

    const w_rel = 0.45;
    const w_heat = 0.25;
    const w_mom = 0.15;
    const w_imp = 0.15;
    const baseComposite =
      w_rel * relevance + w_heat * heatNorm + w_mom * momNorm + w_imp * importanceBoost;

    // Multiply pre-computed decay factors. NULL means the batch hasn't run yet — treat as 1.0 (no demotion).
    // ignore_decay collapses all three factors to 1.0.
    const actv = ignoreDecay ? 1 : r.activation_score ?? 1;
    const ttl = ignoreDecay ? 1 : r.ttl_penalty ?? 1;
    const sup = ignoreDecay ? 1 : r.supersession_penalty ?? 1;
    const composite = baseComposite * actv * ttl * sup;

    const reasons: string[] = [];
    if (r._via === "fts" || r._via === "fts+like" || r._via === "vector+fts") {
      reasons.push(`content_match_${r._via === "fts+like" ? "dual" : "fts"}`);
    }
    if (r._via === "like" || r._via === "fts+like" || r._via === "vector+like") {
      if (
        args.entity_name ||
        (args.query &&
          String(r.entity_name || "")
            .toLowerCase()
            .includes(String(args.query).toLowerCase()))
      ) {
        reasons.push("entity_name_match");
      } else {
        reasons.push("content_substring");
      }
    }
    // Classify vector hit type
    if (
      r._via === "vector" ||
      r._via === "vector+fts" ||
      r._via === "vector+like"
    ) {
      reasons.push("content_match_vector");
      if (r._via === "vector") reasons.push("vector_only");
    }
    if (heat.band === "hot") reasons.push("heat:hot");
    else if (heat.band === "warm") reasons.push("heat:warm");
    if ((r.momentum_score ?? 0) >= 5) reasons.push("entity_active");
    if (r.importance >= 0.9) reasons.push("pinned");
    else if (r.importance >= 0.8) reasons.push("high_importance");
    if (r.protected === 1 && r.layer === "realize") reasons.push("realize_protected");
    if (r.archived_at != null) reasons.push("archive_explicit");
    if (r.superseded_by_id != null) reasons.push("superseded_explicit");

    return {
      ...r,
      heat_score: heat.score,
      heat_band: heat.band,
      composite_score: composite,
      relevance_score: relevance,
      _reasons: reasons,
      _breakdown: {
        relevance: Number(relevance.toFixed(3)),
        heat: Number(heatNorm.toFixed(3)),
        momentum: Number(momNorm.toFixed(3)),
        importance: Number(importanceBoost.toFixed(3)),
        activation: Number(actv.toFixed(3)),
        ttl_penalty: Number(ttl.toFixed(3)),
        supersession_penalty: Number(sup.toFixed(3)),
        activation_computed_at: r.activation_computed_at,
        ...(typeof r._vector_score === "number" && vecNorm != null
          ? {
              vector_cos: Number(r._vector_score.toFixed(3)),
              vector_norm: Number(vecNorm.toFixed(3)),
            }
          : {}),
        // RRF per-path rank; key is omitted when the memory was not retrieved via that path.
        ...(ftsRankById.has(r.id) ? { rrf_fts_rank: ftsRankById.get(r.id) } : {}),
        ...(vecRankById.has(r.id) ? { rrf_vec_rank: vecRankById.get(r.id) } : {}),
      },
    };
  });

  const filtered = band ? scored.filter((s) => s.heat_band === band) : scored;
  filtered.sort((a, b) => b.composite_score - a.composite_score);

  // Format each row for MCP output (content is JSON-parsed when possible).
  // The same function is used both for the token-budget serialization estimate and the final output,
  // so the estimate and the actual response are always consistent.
  const toRecallOutput = (r: ScoredRow) => {
    let parsedContent: unknown = r.content;
    let contentTruncated = false;
    // In snippet_mode, replace content with a window around the query terms only when the content
    // actually exceeds the window. Content that fits within the window is JSON-parsed as normal.
    if (snippetMode) {
      const snippet = extractSnippet(r.content, queryTerms, snippetWindow);
      if (snippet !== r.content) {
        parsedContent = snippet;
        contentTruncated = true;
      }
    }
    if (!contentTruncated) {
      try {
        parsedContent = JSON.parse(r.content);
      } catch {
        /* leave as string */
      }
    }
    return {
      id: r.id,
      entity: {
        id: r.entity_id,
        name: r.entity_name,
        kind: r.entity_kind,
        momentum: Number((r.momentum_score ?? 0).toFixed(2)),
      },
      layer: r.layer,
      content: parsedContent,
      ...(contentTruncated ? { content_truncated: true } : {}),
      importance: r.importance,
      pinned: r.importance >= 0.9,
      heat: Number(r.heat_score.toFixed(1)),
      band: r.heat_band,
      composite: Number(r.composite_score.toFixed(3)),
      match_reasons: r._reasons,
      score_breakdown: r._breakdown,
    };
  };

  const total = filtered.length;
  // Truncate by actual token budget rather than result count. The serializer produces the final formatted object.
  const { selected: windowed, stoppedBy } = selectWithinTokenBudget(
    filtered,
    (r) => JSON.stringify(toRecallOutput(r)),
    { maxTokens, limit: hardLimit, offset, safetyCapTokens: SAFETY_CAP_TOKENS },
  );
  const hasMore = total > offset + windowed.length;

  if (markAccessed && windowed.length > 0) {
    // Append to the rolling access log so the activation batch job can compute ACT-R decay.
    await prisma.$transaction(async (tx) => {
      for (const id of windowed.map((r) => r.id)) {
        await rawRun(
          tx,
          "UPDATE memories SET last_accessed_at = ?, access_count = access_count + 1 WHERE id = ?",
          now,
          id,
        );
        await rawRun(tx, "INSERT INTO memory_access_log (memory_id, accessed_at) VALUES (?, ?)", id, now);
      }
    });
  }

  // Emit a staleness warning so operators can detect a lagging indexing batch.
  // embedding_missing_count reflects the DB-wide count of memories with embedding_status='pending',
  // which is more useful for operational monitoring than counting null embeddings in the returned rows.
  let stalenessWarning: { activation_age_minutes?: number; embedding_missing_count?: number } | undefined;
  if (windowed.length > 0) {
    const computedTimes = windowed
      .map((r) => r.activation_computed_at)
      .filter((t): t is number => t != null);
    const oldest = computedTimes.length > 0 ? Math.min(...computedTimes) : null;
    const ageMin = oldest != null ? Math.floor((now - oldest) / 60) : null;
    const warn: { activation_age_minutes?: number; embedding_missing_count?: number } = {};
    if (oldest == null || (ageMin != null && now - oldest > ACTIVATION_STALE_SECS)) {
      if (ageMin != null) warn.activation_age_minutes = ageMin;
    }
    const pendingRow = await rawAll<{ c: number }>(
      prisma,
      "SELECT COUNT(*) AS c FROM memories WHERE embedding_status='pending' AND archived_at IS NULL",
    );
    const pendingCount = pendingRow[0]?.c ?? 0;
    if (pendingCount > 0) warn.embedding_missing_count = pendingCount;
    if (Object.keys(warn).length > 0) stalenessWarning = warn;
  }

  return JSON.stringify({
    ok: true,
    count: windowed.length,
    total_candidates: total,
    offset,
    has_more: hasMore,
    stopped_by: stoppedBy,
    search: searchMethod,
    resolved_layer: layer ?? null,
    ...(stalenessWarning ? { staleness_warning: stalenessWarning } : {}),
    memories: windowed.map(toRecallOutput),
  });
}
