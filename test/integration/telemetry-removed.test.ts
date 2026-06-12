// T036 / US4 / FR-402,405 / SC-004: telemetry fully removed; CHEST_TELEMETRY ignored.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { validateEnv } from "../../src/utils/env.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("no telemetry references in src/ docs/ README.md package.json (SC-004, CHANGELOG excluded)", () => {
  const paths = ["src", "docs", "README.md", "package.json"].filter((p) => existsSync(join(ROOT, p)));
  const r = spawnSync("grep", ["-rIn", "-E", "telemetry|TELEMETRY|posthog|mixpanel", ...paths], {
    cwd: ROOT,
    encoding: "utf8",
  });
  // The directory name "004-retrieval-decay-untelemetry" is a proper noun indicating
  // that telemetry was removed; it is not a reference to telemetry functionality or config.
  // Exclude it from the scan (listing it in README is fine). Real references like
  // CHEST_TELEMETRY must still be detected.
  const out = (r.stdout ?? "")
    .trim()
    .split("\n")
    .filter((l) => l && !/retrieval-decay-untelemetry/.test(l))
    .join("\n");
  assert.equal(out, "", `expected 0 telemetry references, found:\n${out}`);
});

test("src/lib/telemetry.ts is deleted", () => {
  assert.equal(existsSync(join(ROOT, "src/lib/telemetry.ts")), false);
});

test("CHEST_TELEMETRY is silently ignored by env validation (FR-402)", () => {
  const prev = process.env.CHEST_TELEMETRY;
  process.env.CHEST_TELEMETRY = "basic";
  try {
    const env = validateEnv();
    assert.ok(!("CHEST_TELEMETRY" in env), "CHEST_TELEMETRY must not appear in parsed env");
    assert.equal(env.CHEST_MODE, "local");
  } finally {
    if (prev === undefined) delete process.env.CHEST_TELEMETRY;
    else process.env.CHEST_TELEMETRY = prev;
  }
});
