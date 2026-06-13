#!/usr/bin/env node
// Claude Code UserPromptSubmit hook entry point.
// stdin: { session_id, prompt, cwd }
// Outputs a bounded <chest-recall> block only in remote mode when useful memories are found.
// Fail-silent: exits 0 with empty stdout on any error so user input is never blocked.

import "../utils/temporal.js";
import { createUserPromptSubmitRunnerOptions } from "../lib/hooks/factory.js";
import { appendHookLog, runUserPromptSubmit } from "../lib/hooks/user-prompt-submit-runner.js";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  if ((process.env["CHEST_MODE"] ?? "local") !== "remote") {
    process.exit(0);
  }
  const raw = await readStdin();
  const output = await runUserPromptSubmit(raw, createUserPromptSubmitRunnerOptions());
  if (output) process.stdout.write(output);
  process.exit(0);
}

main().catch((error: unknown) => {
  appendHookLog("user-prompt-submit", `unhandled: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(0);
});
