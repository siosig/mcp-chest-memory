// Dependency-injection ports shared by cycle, submit, fetch, ingest, and reclaim.
import type { PrismaClient } from "@prisma/client";
import type { GeminiBatchClient } from "./gemini-client.js";

export interface Logger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  debug(...args: unknown[]): void;
}

export interface Clock {
  /** Returns the current time as Unix epoch seconds. Inject a fixed clock in tests. */
  nowSec(): number;
}

export const realClock: Clock = {
  nowSec: () => Math.floor(Date.now() / 1000),
};

/** All dependencies required to execute a single embedding cycle. */
export interface CyclePorts {
  prisma: PrismaClient;
  gemini: GeminiBatchClient;
  logger: Logger;
  clock: Clock;
}
