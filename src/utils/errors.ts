import { logger } from "./logger.js";

export class ChestError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class UnknownToolError extends ChestError {
  constructor(name: string) {
    const suggested = name.startsWith("chest_") ? name : `chest_${name}`;
    super(
      `Unknown tool: ${name}. Did you mean ${suggested}?`,
      "UNKNOWN_TOOL",
      "Tool names were renamed to chest_* prefix in v1.0.0. Update your SKILL.md and trigger keywords.",
    );
  }
}

export class RealizeProtectedError extends ChestError {
  constructor(memoryId: number, layer: string) {
    super(
      `Cannot delete protected ${layer} memory ${memoryId}`,
      "REALIZE_PROTECTED",
      `${layer} memories are permanently protected (pain lessons must not be lost). Copy content to another layer first via chest_remember(), then drop the DB row manually via SQLite client.`,
    );
  }
}

export class PinnedProtectedError extends ChestError {
  constructor(memoryId: number) {
    super(
      `Cannot delete pinned memory ${memoryId} (importance >= 0.9)`,
      "PINNED_PROTECTED",
      "Use chest_update_memory to lower importance below 0.9 first, then chest_forget.",
    );
  }
}

export interface ErrorPayload {
  ok: false;
  error: string;
  code?: string;
  hint?: string;
}

export function handleError(error: unknown): ErrorPayload {
  if (error instanceof ChestError) {
    return {
      ok: false,
      error: error.message,
      code: error.code,
      ...(error.hint ? { hint: error.hint } : {}),
    };
  }
  if (error instanceof Error) {
    logger.error({ err: error }, "unhandled error");
    return { ok: false, error: error.message };
  }
  return { ok: false, error: String(error) };
}
