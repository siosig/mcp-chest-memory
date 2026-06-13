// Integration: pending-resync CLI happy-path (mocked provider + in-process server).
//
// The CLI fundamentally orchestrates 3 collaborators: capabilities lookup,
// listPending pagination, updateEmbedding push. The model + HTTP layers are
// exercised through the live Hono app via a fetch shim; the embedding
// provider is overridden to return a deterministic synthetic vector so we
// don't spin up bge-m3 in unit tests.

import { before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { ensurePrismaInitialized, prisma, rawAll } from "../../src/lib/db/prisma-client.js";
import { createApp } from "../../src/http/app.js";
import {
  setActiveProviderForTest,
  type EmbeddingProvider,
} from "../../src/lib/embedding/provider.js";
import { runPendingResync } from "../../src/cli/pending-resync.js";
import { resetEnvCacheForTest } from "../../src/utils/env.js";
import { insEntity, insMemory, resetDb } from "../helpers/db.js";

const TOKEN = "test-token-32chars-aaaaaaaaaaaaaaaa";

function fakeProvider(): EmbeddingProvider {
  return {
    id: "fake-test-provider",
    model: "fake/bge-m3",
    dim: 1024,
    async embedQuery(): Promise<number[] | null> {
      const v: number[] = [];
      for (let i = 0; i < 1024; i++) v.push(0.001);
      return v;
    },
    async embedPassages(texts: string[]): Promise<number[][] | null> {
      return texts.map(() => {
        const v: number[] = [];
        for (let i = 0; i < 1024; i++) v.push(0.001);
        return v;
      });
    },
  };
}

before(async () => {
  await ensurePrismaInitialized();
});

beforeEach(async () => {
  await resetDb();
  setActiveProviderForTest(undefined);
});

describe("chest-index pending-resync", () => {
  test("dry-run prints remaining count and exits 0", async () => {
    const app = createApp({ token: TOKEN, version: "test" });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) =>
      app.request(typeof url === "string" ? url.replace(/^https?:\/\/[^/]+/, "") : url, init)) as typeof fetch;
    setActiveProviderForTest(fakeProvider());
    try {
      const e = await insEntity("topic", "dryrun");
      for (let i = 0; i < 3; i++) {
        await insMemory(e, `dr-${i}`, { embeddingStatus: "pending" });
      }
      process.env.CHEST_API_TOKEN = TOKEN;
      resetEnvCacheForTest();
      const code = await runPendingResync({
        json: true,
        dryRun: true,
        batchSize: 20,
        concurrency: 2,
        maxRetry: 5,
        remoteUrl: "http://localhost:0",
        timeout: 5,
      });
      assert.equal(code, 0);
    } finally {
      globalThis.fetch = realFetch;
      setActiveProviderForTest(undefined);
    }
  });

  test("full run: all pending rows transition to done", async () => {
    const app = createApp({ token: TOKEN, version: "test" });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) =>
      app.request(typeof url === "string" ? url.replace(/^https?:\/\/[^/]+/, "") : url, init)) as typeof fetch;
    setActiveProviderForTest(fakeProvider());
    try {
      const e = await insEntity("topic", "fullrun");
      for (let i = 0; i < 5; i++) {
        await insMemory(e, `full-${i}`, { embeddingStatus: "pending" });
      }
      process.env.CHEST_API_TOKEN = TOKEN;
      resetEnvCacheForTest();
      const code = await runPendingResync({
        json: true,
        dryRun: false,
        batchSize: 2,
        concurrency: 2,
        maxRetry: 1,
        remoteUrl: "http://localhost:0",
        timeout: 5,
      });
      assert.equal(code, 0);
      const remaining = await rawAll<{ c: number }>(
        prisma,
        "SELECT COUNT(*) AS c FROM memories WHERE embedding_status = 'pending'",
      );
      assert.equal(remaining[0]?.c, 0);
    } finally {
      globalThis.fetch = realFetch;
      setActiveProviderForTest(undefined);
    }
  });
});
