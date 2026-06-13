import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const PUBLIC_CONTRACT_FILES = [
  "src/lib/recall/types.ts",
  "src/lib/hooks/prompt-text-strategy.ts",
  "src/schemas/hook-recall.ts",
  "src/schemas/user-prompt-submit.ts",
];

test("new public hook and recall contracts do not use any", () => {
  for (const file of PUBLIC_CONTRACT_FILES) {
    const content = readFileSync(file, "utf8");
    assert.equal(/\bany\b/.test(content), false, `${file} should not use any`);
  }
});
