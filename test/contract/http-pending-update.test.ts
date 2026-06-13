// Contract: POST /memories/:id/embedding
// See specs/014-doctor-healthcheck/contracts/http-pending-update.md

import { createHash } from "node:crypto";
import { before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { ensurePrismaInitialized, prisma, rawGet } from "../../src/lib/db/prisma-client.js";
import { createApp } from "../../src/http/app.js";
import { insEntity, insMemory, resetDb } from "../helpers/db.js";

const TOKEN = "test-token-32chars-aaaaaaaaaaaaaaaa";

function makeVec(dim: number): number[] {
  const a: number[] = [];
  for (let i = 0; i < dim; i++) a.push(Math.sin(i) * 0.01);
  return a;
}

function sha1Hex(text: string): string {
  return createHash("sha1").update(text, "utf8").digest("hex");
}

before(async () => {
  await ensurePrismaInitialized();
});

beforeEach(async () => {
  await resetDb();
});

describe("POST /memories/:id/embedding", () => {
  test("401 without bearer token", async () => {
    const app = createApp({ token: TOKEN, version: "test" });
    const res = await app.request("/memories/1/embedding", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        embedding: makeVec(1024),
        model: "Xenova/bge-m3",
        embedding_status: "ok",
      }),
    });
    assert.equal(res.status, 401);
  });

  test("happy path: 200 + DB updated to status='done'", async () => {
    const app = createApp({ token: TOKEN, version: "test" });
    const e = await insEntity("topic", "pe-happy");
    const memId = await insMemory(e, "to embed", { embeddingStatus: "pending" });
    const res = await app.request(`/memories/${memId}/embedding`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        embedding: makeVec(1024),
        model: "Xenova/bge-m3",
        embedding_status: "ok",
      }),
    });
    assert.equal(res.status, 200);
    const row = await rawGet<{
      embedding: string;
      embedding_status: string;
      embedding_model: string;
      embedding_dim: number;
    }>(
      prisma,
      "SELECT embedding, embedding_status, embedding_model, embedding_dim FROM memories WHERE id = ?",
      memId,
    );
    assert.ok(row);
    assert.equal(row.embedding_status, "done");
    assert.equal(row.embedding_model, "Xenova/bge-m3");
    assert.equal(row.embedding_dim, 1024);
    const arr = JSON.parse(row.embedding) as number[];
    assert.equal(arr.length, 1024);
  });

  test("dim mismatch → 400", async () => {
    const app = createApp({ token: TOKEN, version: "test" });
    const e = await insEntity("topic", "pe-dim");
    const memId = await insMemory(e, "x", { embeddingStatus: "pending" });
    const res = await app.request(`/memories/${memId}/embedding`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        embedding: makeVec(512),
        model: "Xenova/bge-m3",
        embedding_status: "ok",
      }),
    });
    assert.equal(res.status, 400);
  });

  test("unknown id → 404", async () => {
    const app = createApp({ token: TOKEN, version: "test" });
    const res = await app.request("/memories/999999/embedding", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        embedding: makeVec(1024),
        model: "Xenova/bge-m3",
        embedding_status: "ok",
      }),
    });
    assert.equal(res.status, 404);
  });

  test("content_sha1 mismatch → 409", async () => {
    const app = createApp({ token: TOKEN, version: "test" });
    const e = await insEntity("topic", "pe-sha");
    const memId = await insMemory(e, "real content", { embeddingStatus: "pending" });
    const res = await app.request(`/memories/${memId}/embedding`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        embedding: makeVec(1024),
        model: "Xenova/bge-m3",
        embedding_status: "ok",
        content_sha1: sha1Hex("totally different text"),
      }),
    });
    assert.equal(res.status, 409);
  });

  test("idempotent re-send returns 200", async () => {
    const app = createApp({ token: TOKEN, version: "test" });
    const e = await insEntity("topic", "pe-idem");
    const memId = await insMemory(e, "idem", { embeddingStatus: "pending" });
    const body = JSON.stringify({
      embedding: makeVec(1024),
      model: "Xenova/bge-m3",
      embedding_status: "ok",
    });
    const r1 = await app.request(`/memories/${memId}/embedding`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body,
    });
    assert.equal(r1.status, 200);
    const r2 = await app.request(`/memories/${memId}/embedding`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body,
    });
    assert.equal(r2.status, 200);
  });
});
