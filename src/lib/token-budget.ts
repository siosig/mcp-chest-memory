// Token budget management shared by the recall and read-smart paths.
// Provides a lightweight estimate and a pure function that accumulates serialized
// lengths and stops before the budget is exceeded.
// No DB dependency or side effects — fully unit-testable.

// 1 token ≈ 4 chars for English/code; blended average of ~0.3 chars/token is used.
// Shared between recall and read-smart so both paths use the same estimate.
export const TOKENS_PER_CHAR = 0.3;

/** Estimate the token count of a string as ceil(length × TOKENS_PER_CHAR). */
export function estimateTokens(content: string): number {
  return Math.ceil(content.length * TOKENS_PER_CHAR);
}

export interface TokenBudgetOptions {
  /** Maximum output tokens (recall max_tokens contract). */
  maxTokens: number;
  /** Absolute row cap (recall limit; callers pass the schema maximum of 200 when unspecified). */
  limit: number;
  /** Number of leading items to skip (pagination offset). */
  offset: number;
  /**
   * Absolute safety cap in estimated tokens, applied when max_tokens is very large.
   * Second line of defence to stay within the MCP output limit. Unlimited when omitted.
   */
  safetyCapTokens?: number;
}

export interface TokenBudgetResult<T> {
  /** Items selected within budget. */
  selected: T[];
  /** Estimated total tokens consumed by the selected items. */
  usedTokens: number;
  /** Why selection stopped: tokens=budget reached / limit=row cap reached / end=all candidates consumed. */
  stoppedBy: "tokens" | "limit" | "end";
}

/**
 * Walk `items` from `offset`, accumulate estimated tokens via serialize→estimateTokens,
 * and select items until the token budget (min(maxTokens, safetyCapTokens)) or the
 * row cap is reached. At least one item is always returned to prevent empty responses.
 */
export function selectWithinTokenBudget<T>(
  items: T[],
  serialize: (item: T) => string,
  opts: TokenBudgetOptions,
): TokenBudgetResult<T> {
  const cap = Math.min(opts.maxTokens, opts.safetyCapTokens ?? Infinity);
  const selected: T[] = [];
  let usedTokens = 0;
  let stoppedBy: "tokens" | "limit" | "end" = "end";

  for (let i = opts.offset; i < items.length; i++) {
    if (selected.length >= opts.limit) {
      stoppedBy = "limit";
      break;
    }
    const t = estimateTokens(serialize(items[i]));
    // Always include at least 1 item even if it exceeds budget (prevents empty responses).
    if (selected.length > 0 && usedTokens + t > cap) {
      stoppedBy = "tokens";
      break;
    }
    selected.push(items[i]);
    usedTokens += t;
  }

  return { selected, usedTokens, stoppedBy };
}
