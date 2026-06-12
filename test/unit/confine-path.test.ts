// confinePath() — security-grade path confinement for chest_read_smart.
// Verifies fail-closed behavior: out-of-root, empty-roots, and symlink-escape
// all deny; in-root resolves to the canonical path.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, symlinkSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { confinePath } from "../../src/mcp/roots.js";

describe("confinePath (read confinement, fail-closed)", () => {
  let rootDir: string;
  let outsideDir: string;
  let inRootFile: string;
  let outsideFile: string;
  let escapingSymlink: string;
  let roots: { uri: string }[];

  before(() => {
    // realpathSync to canonicalize macOS /var → /private/var etc.
    rootDir = realpathSync(mkdtempSync(join(tmpdir(), "chest-root-")));
    outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "chest-outside-")));
    inRootFile = join(rootDir, "ok.ts");
    outsideFile = join(outsideDir, "secret.txt");
    escapingSymlink = join(rootDir, "escape.txt");
    writeFileSync(inRootFile, "inside");
    writeFileSync(outsideFile, "outside-secret");
    symlinkSync(outsideFile, escapingSymlink); // lives inside root, points outside
    roots = [{ uri: pathToFileURL(rootDir + "/").toString() }];
  });

  after(() => {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it("allows an in-root path and returns its canonical form", () => {
    const got = confinePath(inRootFile, roots);
    assert.equal(got, realpathSync(inRootFile));
  });

  it("denies a path outside every root", () => {
    assert.equal(confinePath(outsideFile, roots), null);
  });

  it("denies (fail-closed) when there are no roots", () => {
    assert.equal(confinePath(inRootFile, []), null);
  });

  it("denies a symlink that lives in-root but resolves outside", () => {
    assert.equal(confinePath(escapingSymlink, roots), null);
  });

  it("denies a non-existent path", () => {
    assert.equal(confinePath(join(rootDir, "nope.txt"), roots), null);
  });
});
