// Model-change semantics: vectors are searchable only under the model that
// produced them, and saving succeeds even when embedding fails.
import { describe, test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { resetDb, insEntity, insMemory } from "../helpers/db.js";
import {
  setActiveProviderForTest,
  type EmbeddingProvider,
} from "../../src/lib/embedding/provider.js";
import { runVectorQuery } from "../../src/lib/search/vector-search.js";
import { LocalExecutor } from "../../src/core/executor.js";

const providerA: EmbeddingProvider = {
  id: "local",
  model: "model-A",
  dim: 3,
  embedQuery: async () => [1, 0, 0],
  embedPassages: async (texts) => texts.map(() => [1, 0, 0]),
};

const providerB: EmbeddingProvider = {
  id: "other",
  model: "model-B",
  dim: 3,
  embedQuery: async () => [1, 0, 0],
  embedPassages: async (texts) => texts.map(() => [1, 0, 0]),
};

beforeEach(async () => {
  await resetDb();
});

after(() => {
  setActiveProviderForTest(undefined);
});

describe("vector search provider filter", () => {
  test("rows from another provider are invisible until reembedded", async () => {
    const eid = await insEntity("project", "p");
    await insMemory(eid, "vector from model A", {
      embedding: JSON.stringify([1, 0, 0]),
      embeddingModel: "model-A",
      embeddingDim: 3,
      embeddingStatus: "done",
    });

    setActiveProviderForTest(providerA);
    const hitsA = await runVectorQuery({ queryVec: [1, 0, 0], topK: 10 });
    assert.equal(hitsA.length, 1, "matching provider sees the row");

    setActiveProviderForTest(providerB);
    const hitsB = await runVectorQuery({ queryVec: [1, 0, 0], topK: 10 });
    assert.equal(hitsB.length, 0, "other provider must not see the row");
  });

  test("dimension mismatch alone also excludes the row", async () => {
    const eid = await insEntity("project", "p");
    await insMemory(eid, "right model wrong dim", {
      embedding: JSON.stringify([1, 0, 0, 0]),
      embeddingModel: "model-A",
      embeddingDim: 4,
      embeddingStatus: "done",
    });
    setActiveProviderForTest(providerA);
    const hits = await runVectorQuery({ queryVec: [1, 0, 0], topK: 10 });
    assert.equal(hits.length, 0);
  });
});

describe("remember resilience", () => {
  test("remember succeeds even when the embedding provider fails", async () => {
    process.env.CHEST_SYNC_EMBED = "1";
    try {
      setActiveProviderForTest({
        ...providerA,
        embedPassages: async () => {
          throw new Error("simulated embedding outage");
        },
      });
      const executor = new LocalExecutor();
      const out = JSON.parse(
        await executor.execute("chest_remember", {
          entity_name: "resilience",
          entity_kind: "project",
          layer: "learning",
          content: "saving must not depend on embedding availability",
        }),
      ) as { ok: boolean };
      assert.equal(out.ok, true);
    } finally {
      process.env.CHEST_SYNC_EMBED = "0";
    }
  });
});
