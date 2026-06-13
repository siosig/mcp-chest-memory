import { test } from "node:test";
import assert from "node:assert/strict";
import { Temporal } from "../../src/utils/temporal.js";
import { runUserPromptSubmit, type RemoteRecallClient } from "../../src/lib/hooks/user-prompt-submit-runner.js";
import type { HookRecalledMemory } from "../../src/schemas/hook-recall.js";
import { hookMemory } from "../fixtures/hook-recall.js";

test("remote-mode prompt-submit recall emits context within the hook budget using injected transport", async () => {
  const remoteClient: RemoteRecallClient = {
    async recallRemote(): Promise<HookRecalledMemory[]> {
      return [
        hookMemory({ id: 1, layer: "realize", content: "Do not duplicate hook search logic." }),
        hookMemory({ id: 2, layer: "learning", content: "Use the recall service port." }),
      ];
    },
  };
  const start = Temporal.Now.instant().epochMilliseconds;
  const output = await runUserPromptSubmit(
    JSON.stringify({
      session_id: "s1",
      prompt: "Please implement the remote prompt recall hook",
      cwd: "/home/siosig/workspace/mcp/mcp-chest-memory",
    }),
    { remoteClient, log: () => undefined },
  );
  const elapsedMs = Temporal.Now.instant().epochMilliseconds - start;
  assert.match(output, /<chest-recall>/);
  assert.match(output, /realize/);
  assert.match(output, /learning/);
  assert.ok(elapsedMs < 3000, `expected under 3000ms, got ${elapsedMs}`);
});
