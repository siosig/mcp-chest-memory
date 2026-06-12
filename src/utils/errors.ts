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
