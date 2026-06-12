// Embedding pipeline tuning constants. Every numeric value can be overridden
// via environment variables (invalid numbers fall back to the default).

function envNum(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultValue;
  const n = Number(raw);
  return Number.isNaN(n) ? defaultValue : n;
}

// --- Validation / limits (env-overridable) ---
export const MAX_CONTENT_CHARS = envNum("CHEST_MAX_CONTENT_CHARS", 8000);
/** Max rows backfilled per `chest-index` embedding sweep. */
export const SWEEP_LIMIT = envNum("CHEST_SWEEP_LIMIT", 500);

// --- Embedding row states ---
// pending: stored but not yet embedded (model unavailable at write time)
// done:    vector stored, searchable when (model, dim) match the provider
export type EmbeddingStatus = "pending" | "done";
