// Bearer token minimum-length policy (FR-016).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateApiToken, MIN_TOKEN_LENGTH } from "../../src/http/token-validate.js";

describe("validateApiToken", () => {
  it("refuses a missing token", () => {
    const r = validateApiToken(undefined);
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /required/i);
  });

  it("refuses an empty token", () => {
    assert.equal(validateApiToken("").ok, false);
  });

  it("refuses a token shorter than the minimum", () => {
    const short = "a".repeat(MIN_TOKEN_LENGTH - 1);
    const r = validateApiToken(short);
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /too short/i);
  });

  it("accepts a token at the minimum length", () => {
    assert.equal(validateApiToken("a".repeat(MIN_TOKEN_LENGTH)).ok, true);
  });

  it("accepts an openssl rand -hex 32 style 64-char token", () => {
    assert.equal(validateApiToken("a".repeat(64)).ok, true);
  });
});
