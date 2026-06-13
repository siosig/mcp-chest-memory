// T031: Deploy-config contract test.
// Validates that all new env vars from the 013-multilingual-recall-quality
// feature are correctly registered in EnvSchema with the right defaults,
// types, and ranges as specified in contracts/env-vars.md.
//
// Uses EnvSchema.parse() directly to bypass validateEnv()'s process-level
// singleton cache, which cannot be reset between test cases.
import "../helpers/test-env.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { EnvSchema, chestRootDir, dictCacheDir, dbPath } from "../../src/utils/env.js";
import { dirname } from "node:path";

// Minimal env that satisfies required fields (DATABASE_URL is set by test-env).
const base = { DATABASE_URL: process.env.DATABASE_URL ?? "" };

describe("deploy-config: new env vars from 013-multilingual-recall-quality", () => {
  it("CHEST_EMBED_MODEL defaults to Xenova/bge-m3", () => {
    const env = EnvSchema.parse({ ...base });
    assert.equal(env.CHEST_EMBED_MODEL, "Xenova/bge-m3");
  });

  it("CHEST_EMBED_MODEL is overridable", () => {
    const env = EnvSchema.parse({ ...base, CHEST_EMBED_MODEL: "Xenova/multilingual-e5-small" });
    assert.equal(env.CHEST_EMBED_MODEL, "Xenova/multilingual-e5-small");
  });

  it("CHEST_RERANK_ENABLED defaults to false (boolean)", () => {
    const env = EnvSchema.parse({ ...base });
    assert.strictEqual(env.CHEST_RERANK_ENABLED, false);
    assert.equal(typeof env.CHEST_RERANK_ENABLED, "boolean");
  });

  it("CHEST_RERANK_ENABLED accepts 'true' as boolean true", () => {
    const env = EnvSchema.parse({ ...base, CHEST_RERANK_ENABLED: "true" });
    assert.strictEqual(env.CHEST_RERANK_ENABLED, true);
  });

  it("CHEST_RERANK_ENABLED accepts '1' as boolean true", () => {
    const env = EnvSchema.parse({ ...base, CHEST_RERANK_ENABLED: "1" });
    assert.strictEqual(env.CHEST_RERANK_ENABLED, true);
  });

  it("CHEST_RERANK_ENABLED treats any other string as false", () => {
    const env = EnvSchema.parse({ ...base, CHEST_RERANK_ENABLED: "false" });
    assert.strictEqual(env.CHEST_RERANK_ENABLED, false);
  });

  it("CHEST_RERANK_MODEL defaults to bge-reranker-v2-m3-ONNX", () => {
    const env = EnvSchema.parse({ ...base });
    assert.equal(env.CHEST_RERANK_MODEL, "onnx-community/bge-reranker-v2-m3-ONNX");
  });

  it("CHEST_RERANK_MODEL is overridable", () => {
    const env = EnvSchema.parse({ ...base, CHEST_RERANK_MODEL: "my/custom-reranker" });
    assert.equal(env.CHEST_RERANK_MODEL, "my/custom-reranker");
  });

  it("CHEST_RERANK_TOP_N defaults to 20", () => {
    const env = EnvSchema.parse({ ...base });
    assert.equal(env.CHEST_RERANK_TOP_N, 20);
  });

  it("CHEST_RERANK_TOP_N accepts numeric string", () => {
    const env = EnvSchema.parse({ ...base, CHEST_RERANK_TOP_N: "50" });
    assert.equal(env.CHEST_RERANK_TOP_N, 50);
  });

  it("CHEST_RERANK_TIMEOUT_MS defaults to 5000", () => {
    const env = EnvSchema.parse({ ...base });
    assert.equal(env.CHEST_RERANK_TIMEOUT_MS, 5000);
  });

  it("CHEST_RERANK_TIMEOUT_MS accepts numeric string", () => {
    const env = EnvSchema.parse({ ...base, CHEST_RERANK_TIMEOUT_MS: "2000" });
    assert.equal(env.CHEST_RERANK_TIMEOUT_MS, 2000);
  });

  it("CHEST_FTS_TOKENIZE defaults to true (boolean)", () => {
    const env = EnvSchema.parse({ ...base });
    assert.strictEqual(env.CHEST_FTS_TOKENIZE, true);
    assert.equal(typeof env.CHEST_FTS_TOKENIZE, "boolean");
  });

  it("CHEST_FTS_TOKENIZE accepts 'false' as boolean false", () => {
    const env = EnvSchema.parse({ ...base, CHEST_FTS_TOKENIZE: "false" });
    assert.strictEqual(env.CHEST_FTS_TOKENIZE, false);
  });

  it("CHEST_FTS_TOKENIZE accepts '0' as boolean false", () => {
    const env = EnvSchema.parse({ ...base, CHEST_FTS_TOKENIZE: "0" });
    assert.strictEqual(env.CHEST_FTS_TOKENIZE, false);
  });

  it("CHEST_FTS_TOKENIZE treats any non-false string as true", () => {
    const env = EnvSchema.parse({ ...base, CHEST_FTS_TOKENIZE: "yes" });
    assert.strictEqual(env.CHEST_FTS_TOKENIZE, true);
  });

  it("chestRootDir() returns dirname of dbPath()", () => {
    assert.equal(chestRootDir(), dirname(dbPath()));
  });

  it("dictCacheDir() is under chestRootDir()", () => {
    assert.ok(
      dictCacheDir().startsWith(chestRootDir()),
      `dictCacheDir ${dictCacheDir()} should be under chestRootDir ${chestRootDir()}`,
    );
  });
});
