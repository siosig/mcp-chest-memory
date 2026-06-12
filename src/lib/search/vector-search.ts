// Vector recall path.
// Only rows with embedding_status='done' and the correct embedding_dim are searched;
// embeddings from a previously used model (different dim) are excluded until
// `chest-index reembed` regenerates them.
//
// Implementation: SQLite has no vector index, so candidate rows are fetched (up to N=2000)
// and cosine similarity is computed in JS. Embeddings are L2-normalized at write time,
// and query vectors are also L2-normalized, so dot product would suffice in theory.
// The full `||a|| * ||b||` form is kept for safety (handles legacy or manually inserted rows).

import { prisma, rawAll } from "../db/prisma-client.js";
import { activeProvider } from "../embedding/provider.js";

export interface VectorSearchOptions {
  queryVec: number[];
  layer?: string;
  topK: number;
  includeArchived?: boolean;
  includeSuperseded?: boolean;
  /** Absolute cap on rows fetched from the DB (default 2000; tunable). */
  candidateLimit?: number;
  /** Vector hits with cosine similarity below this threshold are excluded before the top-K slice. Omit to disable filtering. */
  minCos?: number;
}

export interface VectorHit {
  id: number;
  score: number; // cosine similarity in [-1, 1] (typically 0..1 for unit-normalized vectors)
}

interface RawVectorRow {
  id: number;
  embedding: string; // JSON string, e.g. "[0.1,0.2,...]"
}

function dot(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

function norm(a: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * a[i];
  return Math.sqrt(s);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const na = norm(a);
  const nb = norm(b);
  if (na === 0 || nb === 0) return 0;
  return dot(a, b) / (na * nb);
}

export async function runVectorQuery(opts: VectorSearchOptions): Promise<VectorHit[]> {
  const candidateLimit = opts.candidateLimit ?? 2000;
  // Only rows produced by the active provider are searchable; vectors from a
  // previously used provider (different model/dim) are excluded until
  // `chest-index reembed` regenerates them.
  const provider = activeProvider();
  let sql =
    "SELECT id, embedding FROM memories" +
    " WHERE embedding_status='done' AND embedding_model = ? AND embedding_dim = ?";
  const params: unknown[] = [provider.model, provider.dim];
  if (!opts.includeArchived) sql += " AND archived_at IS NULL";
  if (!opts.includeSuperseded) sql += " AND superseded_by_id IS NULL";
  if (opts.layer) {
    sql += " AND layer = ?";
    params.push(opts.layer);
  }
  sql += " LIMIT ?";
  params.push(candidateLimit);

  const rows = await rawAll<RawVectorRow>(prisma, sql, ...params);
  const hits: VectorHit[] = [];
  for (const r of rows) {
    let vec: number[] | null = null;
    try {
      const parsed = JSON.parse(r.embedding);
      if (Array.isArray(parsed) && parsed.length === opts.queryVec.length) {
        vec = parsed as number[];
      }
    } catch {
      /* skip broken JSON */
    }
    if (!vec) continue;
    const score = cosineSimilarity(opts.queryVec, vec);
    if (opts.minCos !== undefined && score < opts.minCos) continue;
    hits.push({ id: r.id, score });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, opts.topK);
}
