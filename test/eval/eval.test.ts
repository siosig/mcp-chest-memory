// T020: Offline evaluation harness for recall quality.
// Seeds a test SQLite DB from recall-dataset.json memories.
// Uses FakeEmbeddingProvider (deterministic, no real model).
// Runs chest_recall for each case; computes Recall@5, Recall@10, MRR.
// Asserts metrics are valid numbers (structure test, not quality threshold).
// CI-safe: no network, no large model downloads.
import "../helpers/test-env.js";
import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { handleChestRemember } from "../../src/mcp/tools/chest-remember.js";
import { handleChestRecall } from "../../src/mcp/tools/chest-recall.js";
import { setActiveProviderForTest } from "../../src/lib/embedding/provider.js";
import { resetDb } from "../helpers/db.js";
import { resetTokenizerForTest } from "../../src/lib/search/tokenizer.js";
import type { EmbeddingProvider } from "../../src/lib/embedding/provider.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

interface DatasetMemory {
  slug: string;
  entity_name: string;
  entity_kind: string;
  layer: string;
  content: string;
}

interface EvalCase {
  id: string;
  query: string;
  lang: string;
  expectedSlugs: string[];
}

interface Dataset {
  memories: DatasetMemory[];
  cases: EvalCase[];
}

// Keyword-based fake provider: creates a pseudo-vector based on which dataset
// memories contain keywords from the query. Deterministic, no real model.
function buildFakeProvider(memories: DatasetMemory[]): EmbeddingProvider {
  const dim = 64;
  const vocabWords = new Set<string>();
  for (const m of memories) {
    m.content.toLowerCase().split(/\W+/).filter(Boolean).forEach((w) => vocabWords.add(w));
  }
  const vocab = [...vocabWords].slice(0, dim);

  function textToVec(text: string): number[] {
    const lower = text.toLowerCase();
    const v = vocab.map((w) => (lower.includes(w) ? 1.0 : 0.0));
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  }

  return {
    id: "fake-keyword",
    model: "fake-keyword-v0",
    dim,
    embedQuery: async (text: string) => textToVec(text),
    embedPassages: async (texts: string[]) => texts.map(textToVec),
  };
}

function recallAtK(rankings: number[][], k: number): number {
  if (rankings.length === 0) return NaN;
  const hits = rankings.filter((r) => r.some((rank) => rank <= k)).length;
  return hits / rankings.length;
}

function mrr(rankings: number[][]): number {
  if (rankings.length === 0) return NaN;
  const rr = rankings.map((r) => {
    const best = Math.min(...r.filter((x) => x > 0));
    return isFinite(best) ? 1 / best : 0;
  });
  return rr.reduce((s, x) => s + x, 0) / rr.length;
}

interface EvalResult {
  caseId: string;
  lang: string;
  ranks: number[];
}

describe("eval harness — offline recall quality", () => {
  const datasetPath = join(__dirname, "recall-dataset.json");
  const dataset: Dataset = JSON.parse(readFileSync(datasetPath, "utf8"));
  const slugToId = new Map<string, number>();
  const results: EvalResult[] = [];

  before(() => {
    process.env.CHEST_FTS_TOKENIZE = "true";
    resetTokenizerForTest();
    setActiveProviderForTest(buildFakeProvider(dataset.memories));
  });

  beforeEach(async () => {
    await resetDb();
    slugToId.clear();

    // Seed all memories from the dataset.
    for (const mem of dataset.memories) {
      const res = JSON.parse(
        await handleChestRemember({
          entity_name: mem.entity_name,
          entity_kind: mem.entity_kind,
          layer: mem.layer,
          content: mem.content,
          importance: 0.6,
        }),
      );
      assert.equal(res.ok, true, `seed failed for ${mem.slug}: ${JSON.stringify(res)}`);
      slugToId.set(mem.slug, res.memory_id);
    }
  });

  it("all eval cases return a valid recall result with numeric metrics", async () => {
    for (const evalCase of dataset.cases) {
      const recalled = JSON.parse(
        await handleChestRecall({
          query: evalCase.query,
          limit: 10,
          mark_accessed: false,
        }),
      );

      assert.ok(
        Array.isArray(recalled.memories),
        `case ${evalCase.id}: expected memories array`,
      );

      // Map each expected slug to its rank (1-based) in the result, or 0 if absent.
      const recalledIds = (recalled.memories as Array<{ id: number }>).map((m) => m.id);
      const ranks = evalCase.expectedSlugs.map((slug) => {
        const id = slugToId.get(slug);
        if (id === undefined) return 0;
        const pos = recalledIds.indexOf(id);
        return pos >= 0 ? pos + 1 : 0;
      });

      results.push({ caseId: evalCase.id, lang: evalCase.lang, ranks });
    }

    // Aggregate metrics per language subset.
    const langs = ["ja", "en", "mixed", "code"];
    const allRankings: number[][] = [];
    const report: Record<string, { recall5: number; recall10: number; mrr: number; n: number }> =
      {};

    for (const lang of langs) {
      const subset = results.filter((r) => r.lang === lang);
      if (subset.length === 0) continue;

      const rankings = subset.map((r) =>
        r.ranks.length === 0 ? [0] : r.ranks.filter((x) => x > 0),
      );
      allRankings.push(...rankings);

      const r5 = recallAtK(rankings, 5);
      const r10 = recallAtK(rankings, 10);
      const m = mrr(rankings);

      report[lang] = { recall5: r5, recall10: r10, mrr: m, n: subset.length };

      // Structure assertions: values must be valid numbers (not NaN / Infinity).
      assert.ok(isFinite(r5) || isNaN(r5), `Recall@5 for ${lang} must be numeric`);
      assert.ok(isFinite(r10) || isNaN(r10), `Recall@10 for ${lang} must be numeric`);
      assert.ok(isFinite(m) || isNaN(m), `MRR for ${lang} must be numeric`);
    }

    // Overall metrics.
    const overallR5 = recallAtK(allRankings, 5);
    const overallMrr = mrr(allRankings);
    assert.ok(!isNaN(overallR5), "overall Recall@5 must be a number");
    assert.ok(!isNaN(overallMrr), "overall MRR must be a number");

    // Log summary (visible with --test-reporter spec).
    process.stderr.write(
      `\n=== Eval Summary ===\n` +
        langs
          .filter((l) => report[l])
          .map(
            (l) =>
              `  ${l}: Recall@5=${report[l].recall5.toFixed(3)} Recall@10=${report[l].recall10.toFixed(3)} MRR=${report[l].mrr.toFixed(3)} (n=${report[l].n})`,
          )
          .join("\n") +
        `\n  overall: Recall@5=${overallR5.toFixed(3)} MRR=${overallMrr.toFixed(3)}\n`,
    );
  });
});
