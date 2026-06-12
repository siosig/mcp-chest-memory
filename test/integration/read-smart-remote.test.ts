// Remote-mode chest_read_smart: the file is read client-side (under the client's
// roots) while the diff-cache snapshot is persisted to the REST backend through
// RemoteSnapshotStore. This proves the token-saving read survives remote mode —
// the original "Access denied" was the whole tool being forwarded to a backend
// with no client roots; now only the snapshot rows travel.
import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { serve, type ServerType } from "@hono/node-server";
import { mkdtempSync, writeFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { resetDb } from "../helpers/db.js";
import { createApp } from "../../src/http/app.js";
import { RemoteExecutor } from "../../src/http/client.js";
import { RemoteSnapshotStore } from "../../src/mcp/snapshot-store-remote.js";
import { handleReadSmart } from "../../src/mcp/read-smart.js";
import { resetRootsCache } from "../../src/mcp/roots.js";

const TOKEN = "read-smart-remote-token";
let server: ServerType;
let baseUrl = "";
let rootDir: string;
let filePath: string;

// Mimics the MCP client: roots/list resolves to the temp project root, exactly
// as Claude Code would advertise it. The REST backend never sees these roots —
// confinement runs here, in the MCP-server process.
function clientServer(): Server {
  return {
    request: async () => ({ roots: [{ uri: pathToFileURL(rootDir + "/").toString() }] }),
  } as unknown as Server;
}

before(async () => {
  await resetDb();
  rootDir = realpathSync(mkdtempSync(join(tmpdir(), "chest-rsr-")));
  filePath = join(rootDir, "mod.ts");
  writeFileSync(filePath, "export const a = 1;\nexport const b = 2;\n");
  const app = createApp({ token: TOKEN, version: "test" });
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
      baseUrl = `http://127.0.0.1:${info.port}`;
      resolve();
    });
  });
});

after(() => {
  server?.close();
  rmSync(rootDir, { recursive: true, force: true });
});

beforeEach(() => {
  resetRootsCache();
});

describe("chest_read_smart in remote mode (snapshot persisted to backend)", () => {
  test("first read returns content; re-read is served from the remote snapshot", async () => {
    const executor = new RemoteExecutor({ baseUrl, token: TOKEN });
    const store = new RemoteSnapshotStore(executor);
    const srv = clientServer();

    const first = JSON.parse(await handleReadSmart({ path: filePath }, srv, store));
    assert.equal(first.ok, true);
    assert.equal(first.status, "first_read");
    assert.match(first.content, /export const a = 1/);

    // Unchanged file → the snapshot stored on the backend short-circuits the read.
    const second = JSON.parse(await handleReadSmart({ path: filePath }, srv, store));
    assert.equal(second.ok, true);
    assert.equal(second.status, "unchanged");
    assert.equal(second.content, undefined);
    assert.ok(second.tokens_saved > 0);
  });

  test("a real edit returns only the changed chunks", async () => {
    const executor = new RemoteExecutor({ baseUrl, token: TOKEN });
    const store = new RemoteSnapshotStore(executor);
    const srv = clientServer();

    await handleReadSmart({ path: filePath }, srv, store); // seed the snapshot

    // Bump mtime far enough that the second-resolution mtime differs.
    writeFileSync(filePath, "export const a = 1;\nexport const b = 99;\nexport const c = 3;\n");
    const future = Date.now() / 1000 + 5;
    const { utimesSync } = await import("node:fs");
    utimesSync(filePath, future, future);

    const res = JSON.parse(await handleReadSmart({ path: filePath }, srv, store));
    assert.equal(res.ok, true);
    assert.equal(res.status, "modified");
    assert.ok(Array.isArray(res.changed_chunks));
    assert.ok(res.summary.tokens_saved >= 0);
  });

  test("the backend itself still refuses a direct chest_read_smart (fail-closed)", async () => {
    const executor = new RemoteExecutor({ baseUrl, token: TOKEN });
    const res = JSON.parse(await executor.execute("chest_read_smart", { path: filePath }));
    assert.equal(res.ok, false);
    assert.match(res.error, /Access denied/);
  });
});
