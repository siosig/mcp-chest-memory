// Remote-mode equivalence: two RemoteExecutor "clients" against one backend
// share the same store, and failure modes surface as typed errors.
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { serve, type ServerType } from "@hono/node-server";
import { resetDb } from "../helpers/db.js";
import { createApp } from "../../src/http/app.js";
import { RemoteExecutor } from "../../src/http/client.js";
import { ChestError } from "../../src/utils/errors.js";

const TOKEN = "remote-mode-token";
let server: ServerType;
let baseUrl = "";

before(async () => {
  await resetDb();
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
});

describe("remote mode over a real socket", () => {
  test("client A remembers, client B recalls the same memory", async () => {
    const clientA = new RemoteExecutor({ baseUrl, token: TOKEN });
    const clientB = new RemoteExecutor({ baseUrl, token: TOKEN });

    const saved = JSON.parse(
      await clientA.execute("chest_remember", {
        entity_name: "shared-brain",
        entity_kind: "project",
        layer: "learning",
        content: "memories written from PC-A are visible from PC-B",
      }),
    ) as { ok: boolean; memory_id: number };
    assert.equal(saved.ok, true);

    const recalled = JSON.parse(
      await clientB.execute("chest_recall", { query: "visible from PC-B" }),
    ) as { ok: boolean; count: number };
    assert.equal(recalled.ok, true);
    assert.ok(recalled.count >= 1);
  });

  test("wrong token surfaces as UNAUTHORIZED ChestError", async () => {
    const bad = new RemoteExecutor({ baseUrl, token: "nope" });
    await assert.rejects(
      bad.execute("chest_recall", { query: "x" }),
      (e: unknown) => e instanceof ChestError && e.code === "UNAUTHORIZED",
    );
  });

  test("unreachable backend surfaces as BACKEND_UNREACHABLE ChestError", async () => {
    const dead = new RemoteExecutor({
      baseUrl: "http://127.0.0.1:9",
      token: TOKEN,
      timeoutMs: 2000,
    });
    await assert.rejects(
      dead.execute("chest_recall", { query: "x" }),
      (e: unknown) => e instanceof ChestError && e.code === "BACKEND_UNREACHABLE",
    );
  });
});
