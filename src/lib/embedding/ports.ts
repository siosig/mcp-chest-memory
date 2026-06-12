// Small dependency-injection ports shared across maintenance phases.

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
