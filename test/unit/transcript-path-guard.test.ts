// Transcript-path containment guard (High-7). The Stop hook must only import
// transcripts under ~/.claude/projects. isPathInside is the pure decision the
// hook uses after realpath; tested here without filesystem side effects.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isPathInside } from "../../src/lib/path-guard.js";

describe("isPathInside (transcript guard)", () => {
  const root = "/home/u/.claude/projects";

  it("accepts a path under the projects root", () => {
    assert.equal(isPathInside(`${root}/proj/session.jsonl`, root), true);
  });

  it("accepts the root itself", () => {
    assert.equal(isPathInside(root, root), true);
  });

  it("rejects a sibling that shares a name prefix", () => {
    assert.equal(isPathInside("/home/u/.claude/projects-evil/x.jsonl", root), false);
  });

  it("rejects an unrelated path (e.g. /etc/passwd)", () => {
    assert.equal(isPathInside("/etc/passwd", root), false);
  });

  it("rejects a traversal target outside the root", () => {
    assert.equal(isPathInside("/home/u/.ssh/id_rsa", root), false);
  });
});
