import { test } from "node:test";
import assert from "node:assert/strict";
import { DefaultPromptTextStrategy } from "../../src/lib/hooks/prompt-classifier.js";

const strategy = new DefaultPromptTextStrategy();

test("prompt classifier skips English and Japanese acknowledgements", () => {
  for (const prompt of ["ok", "yes", "continue", "はい", "続けて", "了解"]) {
    const result = strategy.classify(prompt);
    assert.equal(result.shouldRecall, false, prompt);
  }
});

test("prompt classifier bounds meaningful prompt queries", () => {
  const longPrompt = `Please implement automatic recall ${"x".repeat(3000)}`;
  const result = strategy.classify(longPrompt);
  assert.equal(result.shouldRecall, true);
  assert.equal(Array.from(result.query).length, 2000);
});
