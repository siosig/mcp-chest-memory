// Unit tests for server capabilities + semver helper (spec 014, T014).

import { test } from "node:test";
import assert from "node:assert/strict";

import { getServerCapabilities, SERVER_FEATURES } from "../../src/core/capabilities.js";
import { validateEnv, resetEnvCacheForTest } from "../../src/utils/env.js";
import { lt, gte } from "../../src/utils/semver.js";
import pkg from "../../package.json" with { type: "json" };

// validateEnv() memoizes its result, so the cache must be cleared whenever we
// flip CHEST_MODE between calls.
function envWith(mode: "local" | "remote") {
  const prev = process.env.CHEST_MODE;
  process.env.CHEST_MODE = mode;
  resetEnvCacheForTest();
  try {
    return validateEnv();
  } finally {
    if (prev === undefined) delete process.env.CHEST_MODE;
    else process.env.CHEST_MODE = prev;
    resetEnvCacheForTest();
  }
}

test("capabilities: api_version mirrors package.json#version", () => {
  const caps = getServerCapabilities(envWith("local"));
  assert.equal(caps.api_version, pkg.version);
  assert.equal(caps.min_required_client_version, pkg.version);
});

test("capabilities: features list is stable and non-empty", () => {
  const caps = getServerCapabilities(envWith("local"));
  assert.deepEqual(caps.features, [...SERVER_FEATURES]);
  assert.ok(caps.features.includes("client-embed"));
  assert.ok(caps.features.includes("pending-resync"));
});

test("capabilities: server_has_embedder flips with CHEST_MODE", () => {
  assert.equal(getServerCapabilities(envWith("local")).server_has_embedder, true);
  assert.equal(getServerCapabilities(envWith("remote")).server_has_embedder, false);
});

test("capabilities: server_time is an ISO-8601 timestamp", () => {
  const caps = getServerCapabilities(envWith("local"));
  assert.match(caps.server_time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  assert.ok(!Number.isNaN(Date.parse(caps.server_time)));
});

test("semver lt: standard major/minor/patch comparisons", () => {
  assert.equal(lt("1.4.0", "1.5.0"), true);
  assert.equal(lt("1.5.0", "1.4.0"), false);
  assert.equal(lt("1.4.9", "1.5.0"), true);
  assert.equal(lt("2.0.0", "1.9.9"), false);
  assert.equal(lt("1.4.0", "1.4.1"), true);
  assert.equal(lt("1.4.0", "1.4.0"), false);
});

test("semver lt: tolerates v-prefix and pre-release/build metadata", () => {
  assert.equal(lt("v1.4.0", "1.5.0"), true);
  assert.equal(lt("1.5.0-rc.1", "1.5.0"), false); // pre-release stripped → equal core
  assert.equal(lt("1.4.0+build.7", "1.4.1"), true);
});

test("semver lt: missing/non-numeric components coerce to 0", () => {
  assert.equal(lt("1", "1.0.1"), true);
  assert.equal(lt("1.0", "1.0.0"), false);
  assert.equal(lt("", "0.0.1"), true);
});

test("semver gte is the negation of lt", () => {
  assert.equal(gte("1.5.0", "1.4.0"), true);
  assert.equal(gte("1.4.0", "1.4.0"), true);
  assert.equal(gte("1.4.0", "1.5.0"), false);
});
