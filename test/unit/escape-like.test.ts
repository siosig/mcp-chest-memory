// escapeLike() — neutralizes SQL LIKE wildcards in user input.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { escapeLike, LIKE_ESCAPE } from "../../src/lib/db/sql-escape.js";

describe("escapeLike", () => {
  it("escapes %, _ and backslash", () => {
    assert.equal(escapeLike("%"), "\\%");
    assert.equal(escapeLike("_"), "\\_");
    assert.equal(escapeLike("\\"), "\\\\");
    assert.equal(escapeLike("a%b_c"), "a\\%b\\_c");
  });

  it("leaves a literal percentage token recoverable", () => {
    // "50%" must remain a literal match after escaping (only the wildcard is neutralized).
    assert.equal(escapeLike("50%"), "50\\%");
  });

  it("is a no-op for input without wildcards", () => {
    assert.equal(escapeLike("plain/path.ts"), "plain/path.ts");
    assert.equal(escapeLike(""), "");
  });

  it("exposes the ESCAPE clause constant", () => {
    assert.equal(LIKE_ESCAPE, "ESCAPE '\\'");
  });
});
