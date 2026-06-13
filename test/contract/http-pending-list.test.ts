// Contract: GET /memories/pending
// See specs/014-doctor-healthcheck/contracts/http-pending-list.md

import { before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { ensurePrismaInitialized } from "../../src/lib/db/prisma-client.js";
import { createApp } from "../../src/http/app.js";
import { insEntity, insMemory, resetDb } from "../helpers/db.js";

const TOKEN = "test-token-32chars-aaaaaaaaaaaaaaaa";

before(async () => {
  await ensurePrismaInitialized();
});

beforeEach(async () => {
  await resetDb();
});

describe("GET /memories/pending", () => {
  test("401 without bearer token", async () => {
    const app = createApp({ token: TOKEN, version: "test" });
    const res = await app.request("/memories/pending");
    assert.equal(res.status, 401);
  });

  test("empty pending → items=[], next_cursor=0, remaining=0", async () => {
    const app = createApp({ token: TOKEN, version: "test" });
    const res = await app.request("/memories/pending", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      items: unknown[];
      next_cursor: number;
      remaining: number;
    };
    assert.deepEqual(body.items, []);
    assert.equal(body.next_cursor, 0);
    assert.equal(body.remaining, 0);
  });

  test("N pending, limit=2 → 2 items, next_cursor=last id, remaining=N", async () => {
    const app = createApp({ token: TOKEN, version: "test" });
    const e = await insEntity("topic", "test-entity");
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(await insMemory(e, `pending-${i}`, { embeddingStatus: "pending" }));
    }
    const res = await app.request("/memories/pending?limit=2", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      items: Array<{ id: number; content: string; text_for_embedding: string }>;
      next_cursor: number;
      remaining: number;
    };
    assert.equal(body.items.length, 2);
    assert.equal(body.next_cursor, body.items[1]?.id);
    assert.equal(body.remaining, 3);
    assert.ok(body.items[0]?.text_for_embedding && body.items[0].text_for_embedding.length > 0);
  });

  test("cursor pagination returns subsequent rows", async () => {
    const app = createApp({ token: TOKEN, version: "test" });
    const e = await insEntity("topic", "cursor-test");
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(await insMemory(e, `c-${i}`, { embeddingStatus: "pending" }));
    }
    const firstPage = await (await app.request("/memories/pending?limit=2", {
      headers: { authorization: `Bearer ${TOKEN}` },
    })).json() as { next_cursor: number; items: Array<{ id: number }> };
    const cursor = firstPage.next_cursor;
    const secondPage = (await (await app.request(`/memories/pending?limit=2&cursor=${cursor}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    })).json()) as { items: Array<{ id: number }>; next_cursor: number };
    assert.equal(secondPage.items.length, 1);
    assert.ok((secondPage.items[0]?.id ?? 0) > cursor);
  });

  test("limit > 200 → 400", async () => {
    const app = createApp({ token: TOKEN, version: "test" });
    const res = await app.request("/memories/pending?limit=300", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(res.status, 400);
  });

  test("archived rows are excluded", async () => {
    const app = createApp({ token: TOKEN, version: "test" });
    const e = await insEntity("topic", "archived-test");
    await insMemory(e, "active", { embeddingStatus: "pending" });
    await insMemory(e, "archived", {
      embeddingStatus: "pending",
      archivedAt: Math.floor(Date.now() / 1000),
    });
    const res = await app.request("/memories/pending", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const body = (await res.json()) as { items: unknown[]; remaining: number };
    assert.equal(body.items.length, 1);
    assert.equal(body.remaining, 1);
  });
});
