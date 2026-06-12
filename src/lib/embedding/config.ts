// Embedding pipeline tuning constants. Every numeric value can be overridden
// via environment variables (invalid numbers fall back to the default).

function envNum(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultValue;
  const n = Number(raw);
  return Number.isNaN(n) ? defaultValue : n;
}

// --- Gemini provider (optional) ---
export const GEMINI_MODEL = "gemini-embedding-001";
export const GEMINI_MODEL_ID = "gemini-embedding-001";
// gemini-embedding-001 with outputDimensionality=768 requires manual L2 normalization.
export const GEMINI_EMBEDDING_DIM = 768;

// --- Validation / limits (env-overridable) ---
export const MAX_CONTENT_CHARS = envNum("CHEST_MAX_CONTENT_CHARS", 8000);
export const TRANSIENT_RETRY_MAX = envNum("CHEST_TRANSIENT_RETRY_MAX", 5);
export const STALE_COUNT_MAX = envNum("CHEST_STALE_COUNT_MAX", 3);
export const STALE_THRESHOLD_SEC = envNum("CHEST_STALE_THRESHOLD_SEC", 86400);
export const MAX_SUBMIT_PER_CYCLE = envNum("CHEST_MAX_SUBMIT_PER_CYCLE", 500);
export const MAX_FETCH_PER_CYCLE = envNum("CHEST_MAX_FETCH_PER_CYCLE", 10);
export const MAX_SUBMIT_BATCHES = envNum("CHEST_MAX_SUBMIT_BATCHES", 4);

// --- State machine string types ---
export type EmbeddingStatus = "pending" | "in_progress" | "done" | "error";
export type ErrorKind = "transient" | "permanent" | "stale";
export type BatchStatus =
  | "submitting"
  | "submitted"
  | "running"
  | "succeeded"
  | "failed"
  | "expired";
