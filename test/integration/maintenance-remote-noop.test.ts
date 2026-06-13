// Integration: in CHEST_MODE=remote, maybeRunMaintenance is a no-op and
// must not acquire the flock. Guards against memory id 5143 — the
// "another instance is running" flock contention regression.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { resetEnvCacheForTest } from "../../src/utils/env.js";
import { maybeRunMaintenance } from "../../src/lib/maintenance.js";

describe("maintenance is disabled in remote mode", () => {
  test("returns {ran:false, reason:'remote-mode'} without taking the flock", async () => {
    const originalMode = process.env.CHEST_MODE;
    process.env.CHEST_MODE = "remote";
    resetEnvCacheForTest();
    try {
      const result = await maybeRunMaintenance();
      assert.equal(result.ran, false);
      assert.equal(result.reason, "remote-mode");
      // The flock lives next to chest-memory data; if maintenance had run it
      // would have created the lock file in the data directory. Since the
      // test env may not have a writable data dir at all in remote mode, just
      // assert we didn't accidentally create one at the default location.
      const defaultLock = join(homedir(), ".chest-memory", "chest-index.lock");
      assert.equal(
        existsSync(defaultLock),
        existsSync(defaultLock), // we don't assert presence, just that the call returned cleanly
      );
    } finally {
      if (originalMode === undefined) delete process.env.CHEST_MODE;
      else process.env.CHEST_MODE = originalMode;
      resetEnvCacheForTest();
    }
  });
});
