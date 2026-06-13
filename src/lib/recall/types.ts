import type { ChestRecallInput } from "../../schemas/chest-recall.js";

export interface RecallRequest extends ChestRecallInput {}

export interface RecalledEntity {
  id: number;
  name: string;
  kind: string;
  momentum: number;
}

export interface RecalledMemorySummary {
  id: number;
  entity: RecalledEntity;
  layer: string;
  content: unknown;
  content_truncated?: boolean;
  importance: number;
  pinned: boolean;
  heat: number;
  band: string;
  composite: number;
  created_at?: string;
  match_reasons: string[];
  score_breakdown: Record<string, unknown>;
}

export interface RecallResult {
  ok: true;
  _notice: string;
  count: number;
  total_candidates: number;
  offset: number;
  has_more: boolean;
  stopped_by?: string;
  search: string;
  resolved_layer: string | null;
  memories: RecalledMemorySummary[];
}

/** Adapter boundary for recall execution. Implementations may use FTS, vector search, or a test double. */
export interface RecallServicePort {
  recall(request: RecallRequest): Promise<RecallResult>;
}
