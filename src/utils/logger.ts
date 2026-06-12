import pino from "pino";

export const logger = pino(pino.destination(2));

export function guardStdoutAgainstConsoleLog(): void {
  if (process.env["CHEST_SERVER"] !== "1") {
    console.log = console.error;
    console.info = console.error;
  }
}
