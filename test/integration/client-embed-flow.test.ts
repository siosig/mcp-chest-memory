// Integration: remote-mode chest_remember triggers a client-side embed push.
// The flow is sketched here with mocked components — full e2e with a real
// network and bge-m3 model is exercised manually per quickstart.md.

import { before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { ensurePrismaInitialized } from "../../src/lib/db/prisma-client.js";
import { createApp } from "../../src/http/app.js";
import { CapabilitiesClient } from "../../src/http/client.js";
import { insEntity, insMemory, resetDb } from "../helpers/db.js";

const TOKEN = "test-token-32chars-aaaaaaaaaaaaaaaa";

before(async () => {
  await ensurePrismaInitialized();
});

beforeEach(async () => {
  await resetDb();
});

describe("client embed flow (mocked)", () => {
  test("CapabilitiesClient memoizes /capabilities", async () => {
    const app = createApp({ token: TOKEN, version: "test" });
    // Hand-rolled fetch override: count calls
    let calls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls++;
      return app.request(typeof url === "string" ? url.replace(/^https?:\/\/[^/]+/, "") : url, init);
    }) as typeof fetch;
    try {
      const client = new CapabilitiesClient({
        baseUrl: "http://localhost:0",
        token: TOKEN,
      });
      const c1 = await client.getCapabilities();
      const c2 = await client.getCapabilities();
      assert.equal(calls, 1, "second call must be served from memo cache");
      assert.equal(c1.api_version, c2.api_version);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("listPending → updateEmbedding round-trip clears the pending row", async () => {
    const app = createApp({ token: TOKEN, version: "test" });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      return app.request(typeof url === "string" ? url.replace(/^https?:\/\/[^/]+/, "") : url, init);
    }) as typeof fetch;
    try {
      const e = await insEntity("topic", "flow");
      const memId = await insMemory(e, "pending-content", { embeddingStatus: "pending" });
      const client = new CapabilitiesClient({
        baseUrl: "http://localhost:0",
        token: TOKEN,
      });
      const page = await client.listPending(0, 50);
      assert.equal(page.items.length, 1);
      assert.equal(page.items[0]?.id, memId);

      const vec: number[] = [];
      for (let i = 0; i < 1024; i++) vec.push(0.001);
      await client.updateEmbedding(memId, vec, "Xenova/bge-m3");

      const page2 = await client.listPending(0, 50);
      assert.equal(page2.items.length, 0);
      assert.equal(page2.remaining, 0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
