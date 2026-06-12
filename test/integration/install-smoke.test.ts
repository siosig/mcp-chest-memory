// End-to-end installer smoke test. Heavy (runs the real install.sh including
// a build), so it only runs when explicitly requested:
//   CHEST_E2E=1 npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("../..", import.meta.url).pathname;

test("install.sh / uninstall.sh smoke (idempotent)", { skip: process.env.CHEST_E2E !== "1" }, () => {
  const home = mkdtempSync(join(tmpdir(), "chest-e2e-home-"));
  const dataDir = join(home, ".chest-memory");
  const env = { ...process.env, HOME: home, CHEST_DATA_DIR: dataDir };

  try {
    // Twice: the second run must succeed without breaking anything.
    for (let i = 0; i < 2; i++) {
      execFileSync("bash", ["tools/install.sh", "--skip-model", "--data-dir", dataDir], {
        cwd: ROOT,
        env,
        stdio: "pipe",
        timeout: 600_000,
      });
    }
    assert.ok(existsSync(join(dataDir, "chest.db")), "database initialized");

    execFileSync("bash", ["tools/uninstall.sh", "--purge", "--data-dir", dataDir], {
      cwd: ROOT,
      env,
      stdio: "pipe",
      timeout: 60_000,
    });
    assert.ok(!existsSync(dataDir), "data directory removed with --purge");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
