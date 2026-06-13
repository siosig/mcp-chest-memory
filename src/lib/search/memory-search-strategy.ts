import type { RecallRequest, RecallResult } from "../recall/types.js";

export interface MemorySearchCandidate {
  id: number;
  score: number;
  source: "fts" | "like" | "vector" | "hybrid" | "test";
}

/** Strategy boundary for future candidate retrieval implementations behind the recall service. */
export interface MemorySearchStrategy {
  search(request: RecallRequest): Promise<RecallResult>;
}
