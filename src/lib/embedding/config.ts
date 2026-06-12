// Embedding pipeline tuning constants. Every numeric value can be overridden
// via environment variables (invalid numbers fall back to the default).

function envNum(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultValue;
  const n = Number(raw);
  return Number.isNaN(n) ? defaultValue : n;
}

// Clamped variant: rejects NaN and out-of-range values (e.g. 0 / negative /
// absurdly large) by falling back to the default, so a misconfigured limit can
// never silently disable a safety cap. Used for limits that gate protection.
function envNumClamped(name: string, defaultValue: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultValue;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) return defaultValue;
  return Math.floor(n);
}

// --- Validation / limits (env-overridable) ---
/** Max memory content length. Clamped so 0/negative cannot disable the cap. */
export const MAX_CONTENT_CHARS = envNumClamped("CHEST_MAX_CONTENT_CHARS", 8000, 1, 1_000_000);
/** Max rows backfilled per `chest-index` embedding sweep. */
export const SWEEP_LIMIT = envNum("CHEST_SWEEP_LIMIT", 500);
/** Max memories archived per argument-less `chest_forget` sweep (DoS bound). */
export const FORGET_SWEEP_CAP = envNumClamped("CHEST_FORGET_SWEEP_CAP", 200, 1, 10_000);
