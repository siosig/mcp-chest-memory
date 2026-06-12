// chest_read_smart path confinement (Critical finding).
// (a) local mode with a temp root: in-root read works, out-of-root refused;
// (b) empty-roots context (REST backend has no client): every read refused;
// (c) symlink escape refused.
import { describe, it, beforeEach, before, after } from "node:test";
import assert from "node:assert/strict";
import { resetDb } from "../helpers/db.js";
import { mkdtempSync, writeFileSync, symlinkSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { handleReadSmart } from "../../src/mcp/read-smart.js";
import { LocalSnapshotStore } from "../../src/mcp/snapshot-store.js";
import { resetRootsCache } from "../../src/mcp/roots.js";

const store = new LocalSnapshotStore();

// Minimal Server stub whose roots/list returns the configured roots, or throws
// (mimicking the REST backend's no-client context) when roots is null.
function serverWithRoots(roots: { uri: string }[] | null): Server {
  return {
    request: async () => {
      if (roots === null) throw new Error("no MCP client attached");
      return { roots };
    },
  } as unknown as Server;
}

describe("chest_read_smart confinement", () => {
  let rootDir: string;
  let outsideDir: string;
  let inRootFile: string;
  let outsideFile: string;
  let escapingSymlink: string;

  before(() => {
    rootDir = realpathSync(mkdtempSync(join(tmpdir(), "chest-rs-root-")));
    outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "chest-rs-out-")));
    inRootFile = join(rootDir, "file.ts");
    outsideFile = join(outsideDir, "passwd");
    escapingSymlink = join(rootDir, "escape");
    writeFileSync(inRootFile, "const a = 1;\n");
    writeFileSync(outsideFile, "root:x:0:0\n");
    symlinkSync(outsideFile, escapingSymlink);
  });

  after(() => {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await resetDb();
    resetRootsCache();
  });

  it("reads an in-root file (behavior unchanged)", async () => {
    const server = serverWithRoots([{ uri: pathToFileURL(rootDir + "/").toString() }]);
    const res = JSON.parse(await handleReadSmart({ path: inRootFile }, server, store));
    assert.equal(res.ok, true);
    assert.equal(res.status, "first_read");
    assert.match(res.content, /const a = 1/);
  });

  it("refuses an out-of-root path", async () => {
    const server = serverWithRoots([{ uri: pathToFileURL(rootDir + "/").toString() }]);
    const res = JSON.parse(await handleReadSmart({ path: outsideFile }, server, store));
    assert.equal(res.ok, false);
    assert.equal(res.content, undefined);
    assert.match(res.error, /Access denied/);
  });

  it("refuses a symlink that escapes the root", async () => {
    const server = serverWithRoots([{ uri: pathToFileURL(rootDir + "/").toString() }]);
    const res = JSON.parse(await handleReadSmart({ path: escapingSymlink }, server, store));
    assert.equal(res.ok, false);
    assert.match(res.error, /Access denied/);
  });

  it("refuses every read when no roots exist (REST backend context)", async () => {
    const server = serverWithRoots(null); // request throws → fetchRoots returns []
    const res = JSON.parse(await handleReadSmart({ path: inRootFile }, server, store));
    assert.equal(res.ok, false);
    assert.equal(res.content, undefined);
    assert.match(res.error, /Access denied/);
  });
});
