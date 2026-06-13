// T021: Real-model eval script (NOT in npm test / CI).
// Loads the actual activeProvider() and real chest-recall pipeline.
// Outputs JSON to stdout and human-readable table to stderr.
// Run manually: node --import tsx test/eval/eval-real.ts
//
// Prerequisites:
//   CHEST_DB_PATH / DATABASE_URL must point to a seeded database.
//   Run `chest-index migrate && chest-index reembed` first to populate embeddings.
//
// The script seeds its own temp database from recall-dataset.json so it is
// self-contained without touching production data.

import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = join(__dirname, "../..");

// Use the persistent chest-memory directory so the model cache is shared with
// the production install. Only the eval DB itself is ephemeral.
const dir = join(homedir(), ".chest-memory");
mkdirSync(dir, { recursive: true });
const dbFile = join(dir, `eval-temp-${Date.now()}.db`);
const db = new DatabaseSync(dbFile);
db.exec(readFileSync(join(repoRoot, "prisma/migrations/0_init/migration.sql"), "utf8"));
db.exec(readFileSync(join(repoRoot, "prisma/migrations/1_multilingual_fts/migration.sql"), "utf8"));
db.close();

process.env.DATABASE_URL = `file:${dbFile}`;
process.env.CHEST_DB_PATH = dbFile;
process.env.CHEST_DATA_DIR = dir;
process.env.CHEST_SYNC_EMBED = "1";
process.env.CHEST_AUTO_MAINTENANCE = "0";
process.env.CHEST_FTS_TOKENIZE = "true";

// Dynamic imports come after env setup.
const { handleChestRemember } = await import("../../src/mcp/tools/chest-remember.js");
const { handleChestRecall } = await import("../../src/mcp/tools/chest-recall.js");
const { activeProvider } = await import("../../src/lib/embedding/provider.js");
const { ensurePrismaInitialized } = await import("../../src/lib/db/prisma-client.js");
await ensurePrismaInitialized();

const datasetPath = join(__dirname, "recall-dataset.json");

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

const dataset: Dataset = JSON.parse(readFileSync(datasetPath, "utf8"));
const slugToId = new Map<string, number>();

process.stderr.write(`Provider: ${activeProvider().id} (${activeProvider().model})\n`);
process.stderr.write(`Seeding ${dataset.memories.length} memories…\n`);

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
  if (!res.ok) {
    process.stderr.write(`WARN seed failed for ${mem.slug}: ${JSON.stringify(res)}\n`);
    continue;
  }
  slugToId.set(mem.slug, res.memory_id);
}

process.stderr.write(`Running ${dataset.cases.length} eval cases…\n\n`);

interface CaseResult {
  id: string;
  lang: string;
  query: string;
  expectedSlugs: string[];
  recalledIds: number[];
  ranks: number[];
  latencyMs: number;
}

const caseResults: CaseResult[] = [];
const startRss = process.memoryUsage().rss;

for (const evalCase of dataset.cases) {
  const t0 = performance.now();
  const recalled = JSON.parse(
    await handleChestRecall({
      query: evalCase.query,
      limit: 10,
      mark_accessed: false,
    }),
  );
  const latencyMs = performance.now() - t0;

  const recalledIds = (recalled.memories ?? []).map((m: { id: number }) => m.id);
  const ranks = evalCase.expectedSlugs.map((slug) => {
    const id = slugToId.get(slug);
    if (id === undefined) return 0;
    const pos = recalledIds.indexOf(id);
    return pos >= 0 ? pos + 1 : 0;
  });

  caseResults.push({
    id: evalCase.id,
    lang: evalCase.lang,
    query: evalCase.query,
    expectedSlugs: evalCase.expectedSlugs,
    recalledIds,
    ranks,
    latencyMs,
  });
}

const peakRssMb = process.memoryUsage().rss / 1024 / 1024;

function recallAtK(results: CaseResult[], k: number): number {
  if (results.length === 0) return NaN;
  const hits = results.filter((r) =>
    r.ranks.length === 0 ? false : r.ranks.some((rank) => rank > 0 && rank <= k),
  ).length;
  return hits / results.length;
}

function mrrScore(results: CaseResult[]): number {
  if (results.length === 0) return NaN;
  const rr = results.map((r) => {
    const validRanks = r.ranks.filter((x) => x > 0);
    if (validRanks.length === 0) return 0;
    return 1 / Math.min(...validRanks);
  });
  return rr.reduce((s, x) => s + x, 0) / rr.length;
}

const langs = ["ja", "en", "mixed", "code"];
const subsets: Record<string, CaseResult[]> = {};
for (const lang of langs) {
  subsets[lang] = caseResults.filter((r) => r.lang === lang);
}

// Human-readable table to stderr.
process.stderr.write("┌────────┬──────────┬───────────┬───────┐\n");
process.stderr.write("│ Subset │ Recall@5 │ Recall@10 │   MRR │\n");
process.stderr.write("├────────┼──────────┼───────────┼───────┤\n");

for (const lang of langs) {
  const s = subsets[lang] ?? [];
  if (s.length === 0) continue;
  const r5 = recallAtK(s, 5).toFixed(3);
  const r10 = recallAtK(s, 10).toFixed(3);
  const m = mrrScore(s).toFixed(3);
  process.stderr.write(`│ ${lang.padEnd(6)} │ ${r5.padStart(8)} │ ${r10.padStart(9)} │ ${m.padStart(5)} │\n`);
}
process.stderr.write("├────────┼──────────┼───────────┼───────┤\n");
process.stderr.write(
  `│ ${"ALL".padEnd(6)} │ ${recallAtK(caseResults, 5).toFixed(3).padStart(8)} │ ${recallAtK(caseResults, 10).toFixed(3).padStart(9)} │ ${mrrScore(caseResults).toFixed(3).padStart(5)} │\n`,
);
process.stderr.write("└────────┴──────────┴───────────┴───────┘\n");
process.stderr.write(`\nPeak RSS: ${peakRssMb.toFixed(1)} MB\n`);
process.stderr.write(
  `Avg latency: ${(caseResults.reduce((s, r) => s + r.latencyMs, 0) / caseResults.length).toFixed(1)} ms/query\n`,
);

// JSON output to stdout.
const output = {
  provider: { id: activeProvider().id, model: activeProvider().model },
  metrics: {
    overall: {
      recall5: recallAtK(caseResults, 5),
      recall10: recallAtK(caseResults, 10),
      mrr: mrrScore(caseResults),
    },
    byLang: Object.fromEntries(
      langs.map((l) => [
        l,
        {
          recall5: recallAtK(subsets[l] ?? [], 5),
          recall10: recallAtK(subsets[l] ?? [], 10),
          mrr: mrrScore(subsets[l] ?? []),
          n: (subsets[l] ?? []).length,
        },
      ]),
    ),
  },
  peakRssMb,
  cases: caseResults.map((r) => ({
    id: r.id,
    lang: r.lang,
    latencyMs: Math.round(r.latencyMs),
    ranks: r.ranks,
  })),
};

process.stdout.write(JSON.stringify(output, null, 2) + "\n");

// Cleanup: remove only the eval DB, not the persistent data directory.
try {
  for (const suffix of ["", "-shm", "-wal"]) {
    rmSync(`${dbFile}${suffix}`, { force: true });
  }
} catch {
  // Non-fatal.
}
