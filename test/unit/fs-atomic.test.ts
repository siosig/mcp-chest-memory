// writeFileAtomic() — atomic, owner-only file writes (High-7 / Medium-3).
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../../src/lib/fs-atomic.js";

describe("writeFileAtomic", () => {
  let dir: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "chest-atomic-"));
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes content and applies owner-only mode 0600", () => {
    const target = join(dir, "settings.json");
    writeFileAtomic(target, '{"a":1}\n');
    assert.equal(readFileSync(target, "utf8"), '{"a":1}\n');
    const mode = statSync(target).mode & 0o777;
    assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
  });

  it("leaves no temp files behind on success", () => {
    const target = join(dir, "clean.json");
    writeFileAtomic(target, "x");
    const leftovers = readdirSync(dir).filter((f) => f.includes(".tmp"));
    assert.deepEqual(leftovers, []);
  });

  it("does not destroy the existing file when the write fails", () => {
    const target = join(dir, "keep.json");
    writeFileSync(target, "ORIGINAL");
    // Force a failure: pass a non-string to trigger a throw before rename.
    assert.throws(() => writeFileAtomic(target, undefined as unknown as string));
    assert.equal(readFileSync(target, "utf8"), "ORIGINAL", "original must survive a failed write");
    const leftovers = readdirSync(dir).filter((f) => f.includes(".tmp"));
    assert.deepEqual(leftovers, [], "failed write must not leave temp files");
  });
});
