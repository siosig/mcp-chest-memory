// REST API contract tests (in-process via Hono app.request — no sockets).
import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { resetDb } from "../helpers/db.js";
import { ensurePrismaInitialized } from "../../src/lib/db/prisma-client.js";
import { createApp } from "../../src/http/app.js";

const TOKEN = "test-token-123";
const app = createApp({ token: TOKEN, version: "test" });

// The production REST server initializes Prisma before it starts serving;
// mirror that here so /healthz observes a ready DB (an uninitialized client
// correctly reports 503, which is exercised implicitly by skipping this).
before(async () => {
  await ensurePrismaInitialized();
});

function authHeaders(token: string = TOKEN): Record<string, string> {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

describe("REST backend contract", () => {
  test("healthz responds without auth and reports provider info", async () => {
    const res = await app.request("/healthz");
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok: boolean;
      db: string;
      embedding: { provider: string; model: string; dim: number };
    };
    assert.equal(body.ok, true);
    assert.equal(body.db, "ok");
    assert.ok(body.embedding.provider.length > 0);
    assert.ok(body.embedding.dim > 0);
  });

  test("missing Authorization header yields 401", async () => {
    const res = await app.request("/api/tools/chest_recall", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "x" }),
    });
    assert.equal(res.status, 401);
  });

  test("wrong bearer token yields 401", async () => {
    const res = await app.request("/api/tools/chest_recall", {
      method: "POST",
      headers: authHeaders("wrong-token"),
      body: JSON.stringify({ query: "x" }),
    });
    assert.equal(res.status, 401);
  });

  test("unknown tool yields 404 UNKNOWN_TOOL", async () => {
    const res = await app.request("/api/tools/chest_nope", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 404);
    const body = (await res.json()) as { ok: boolean; error: { code: string } };
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "UNKNOWN_TOOL");
  });

  test("schema violation yields 400 VALIDATION_ERROR", async () => {
    const res = await app.request("/api/tools/chest_remember", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ unexpected: true }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, "VALIDATION_ERROR");
  });

  test("remember -> recall roundtrip through the REST surface", async () => {
    await resetDb();
    const remember = await app.request("/api/tools/chest_remember", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        entity_name: "rest-contract",
        entity_kind: "project",
        layer: "learning",
        content: "the rest backend roundtrip works end to end",
      }),
    });
    assert.equal(remember.status, 200);
    const rBody = (await remember.json()) as { ok: boolean; result: { ok: boolean } };
    assert.equal(rBody.ok, true);
    assert.equal(rBody.result.ok, true);

    const recall = await app.request("/api/tools/chest_recall", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ query: "roundtrip backend" }),
    });
    assert.equal(recall.status, 200);
    const c = (await recall.json()) as {
      ok: boolean;
      result: { ok: boolean; count: number; memories: Array<{ content: unknown }> };
    };
    assert.equal(c.ok, true);
    assert.ok(c.result.count >= 1, "stored memory should be recallable");
  });
});
