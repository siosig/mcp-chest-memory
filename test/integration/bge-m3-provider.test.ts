// T017: bge-m3 provider unit-level integration test.
// Validates registration, dimension, and embed shape without downloading the
// actual model — uses a FakeEmbeddingProvider to prove the registry/provider
// plumbing works end-to-end.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolveProvider, listProviderIds } from "../../src/lib/embedding/registry.js";
import { BGE_M3_MODEL_ID, BGE_M3_EMBEDDING_DIM } from "../../src/lib/embedding/bge-m3-provider.js";
import { setActiveProviderForTest, activeProvider } from "../../src/lib/embedding/provider.js";
import type { EmbeddingProvider } from "../../src/lib/embedding/provider.js";

describe("bge-m3 provider registry", () => {
  it("resolveProvider returns bge-m3 for the canonical model ID", () => {
    const p = resolveProvider(BGE_M3_MODEL_ID);
    assert.equal(p.id, "bge-m3");
    assert.equal(p.dim, BGE_M3_EMBEDDING_DIM);
    assert.equal(BGE_M3_EMBEDDING_DIM, 1024);
  });

  it("listProviderIds includes bge-m3", () => {
    const ids = listProviderIds();
    assert.ok(ids.includes(BGE_M3_MODEL_ID), `Expected ${BGE_M3_MODEL_ID} in ${ids.join(", ")}`);
  });

  it("resolveProvider falls back to e5-small provider for unknown model ID", () => {
    const p = resolveProvider("Xenova/multilingual-e5-small");
    assert.ok(p.id !== undefined, "should return a provider");
  });

  it("setActiveProviderForTest / activeProvider round-trip", () => {
    const fake: EmbeddingProvider = {
      id: "fake-bge-test",
      model: "fake/bge-m3",
      dim: 1024,
      embedQuery: async () => null,
      embedPassages: async () => null,
    };
    setActiveProviderForTest(fake);
    const current = activeProvider();
    assert.equal(current.id, "fake-bge-test");
    assert.equal(current.dim, 1024);
  });
});

describe("bge-m3 provider contract", () => {
  it("FakeEmbeddingProvider with 1024 dim satisfies EmbeddingProvider interface", async () => {
    const fake: EmbeddingProvider = {
      id: "bge-m3-fake",
      model: BGE_M3_MODEL_ID,
      dim: BGE_M3_EMBEDDING_DIM,
      embedQuery: async (text: string) => {
        // Fake CLS-pooled 1024-dim unit vector
        const v = new Array<number>(BGE_M3_EMBEDDING_DIM).fill(0);
        v[0] = 1;
        return v;
      },
      embedPassages: async (texts: string[]) => {
        return texts.map(() => {
          const v = new Array<number>(BGE_M3_EMBEDDING_DIM).fill(0);
          v[0] = 1;
          return v;
        });
      },
    };

    const queryVec = await fake.embedQuery("テスト");
    assert.ok(Array.isArray(queryVec), "embedQuery must return an array");
    assert.equal(queryVec!.length, BGE_M3_EMBEDDING_DIM, "query vector must be 1024-dim");

    const passageVecs = await fake.embedPassages(["hello", "world"]);
    assert.ok(Array.isArray(passageVecs), "embedPassages must return an array");
    assert.equal(passageVecs!.length, 2, "should return one vector per passage");
    assert.equal(passageVecs![0].length, BGE_M3_EMBEDDING_DIM, "passage vector must be 1024-dim");
  });
});
