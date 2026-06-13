import { test } from "node:test";
import assert from "node:assert/strict";
import { runUserPromptSubmit, type RemoteRecallClient } from "../../src/lib/hooks/user-prompt-submit-runner.js";
import type { PromptTextStrategy } from "../../src/lib/hooks/prompt-text-strategy.js";
import type { HookRecalledMemory } from "../../src/schemas/hook-recall.js";
import { hookMemory } from "../fixtures/hook-recall.js";

test("prompt-submit runner accepts a fake prompt strategy without orchestration changes", async () => {
  let calledQuery = "";
  const strategy: PromptTextStrategy = {
    classify(): ReturnType<PromptTextStrategy["classify"]> {
      return { shouldRecall: true, query: "strategy query", reason: "meaningful" };
    },
  };
  const remoteClient: RemoteRecallClient = {
    async recallRemote(query): Promise<HookRecalledMemory[]> {
      calledQuery = query;
      return [hookMemory()];
    },
  };

  const output = await runUserPromptSubmit(
    JSON.stringify({ session_id: "s1", prompt: "ok", cwd: "/home/user/workspace/mcp/mcp-chest-memory" }),
    { promptStrategy: strategy, remoteClient, log: () => undefined },
  );

  assert.equal(calledQuery, "strategy query");
  assert.match(output, /<chest-recall>/);
});

test("prompt-submit runner is fail-silent for malformed JSON and remote failures", async () => {
  const remoteClient: RemoteRecallClient = {
    async recallRemote(): Promise<[]> {
      throw new Error("backend down");
    },
  };
  assert.equal(await runUserPromptSubmit("{", { remoteClient, log: () => undefined }), "");
  assert.equal(
    await runUserPromptSubmit(
      JSON.stringify({ prompt: "Please recall remote failures", cwd: "/tmp/project" }),
      { remoteClient, log: () => undefined, timeoutMs: 10 },
    ),
    "",
  );
});
