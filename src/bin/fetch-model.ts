#!/usr/bin/env node
// Prefetch / verify the embedding model (and optional reranker) so the runtime
// is fully offline afterwards. Idempotent: already-cached files report as
// `cached` without network traffic.
//
// Atomic write strategy (FR-032, research.md R3):
//   - Each file is written to `<file>.tmp` first, then `fs.rename` makes it
//     the canonical name. Same-filesystem rename is atomic on POSIX, which
//     guarantees no partially-written file is ever observed by readers.
//   - A pre-pass deletes any leftover `*.tmp` and zero-byte `.onnx` / `.json`
//     files in the cache directory (recovers from SIGTERM / OOM during a
//     previous run). This is the root fix for memory ID 5138 — partial files
//     used to poison `extractorPromise` permanently.
//
// Exit codes: 0 = all files ready, non-zero = at least one failure.
//
// Usage:
//   chest-fetch-model                    prefetch activeProvider().model
//   chest-fetch-model --reranker         also prefetch the reranker model
//   chest-fetch-model --force            re-download even if cached
//   chest-fetch-model --model <id>       prefetch a specific model id
//   chest-fetch-model --json             emit a ModelFetchReport on stdout

import {
  createWriteStream,
  existsSync,
  mkdirSync,
  promises as fsp,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { activeProvider } from "../lib/embedding/provider.js";
import { modelCacheDir, validateEnv } from "../utils/env.js";
import { logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Types (mirror data-model.md §3 / §4)
// ---------------------------------------------------------------------------

export type ModelFileStatus = "downloaded" | "cached" | "failed";

export interface ModelFetchResult {
  model_id: string;
  filename: string;
  status: ModelFileStatus;
  bytes: number;
  duration_ms: number;
  error?: string;
}

export interface ModelFetchReport {
  started_at: string;
  finished_at: string;
  models: string[];
  results: ModelFetchResult[];
  total_bytes: number;
  exit_code: number;
}

export interface FetchModelArgs {
  json?: boolean;
  reranker?: boolean;
  force?: boolean;
  modelId?: string;
}

// ---------------------------------------------------------------------------
// File selection per model. transformers.js v3 picks the ONNX variant by
// `dtype`; we keep the set minimal but sufficient for both providers.
// ---------------------------------------------------------------------------

const RERANKER_MODEL_ID = "onnx-community/bge-reranker-v2-m3-ONNX";

function filesForModel(modelId: string): string[] {
  if (modelId === RERANKER_MODEL_ID) {
    return [
      "config.json",
      "tokenizer.json",
      "tokenizer_config.json",
      "special_tokens_map.json",
      "sentencepiece.bpe.model",
      // reranker uses dtype: "q4"
      "onnx/model_q4.onnx",
    ];
  }
  // Default set: matches Xenova/bge-m3 and similar feature-extraction repos
  // (bge-m3 provider uses dtype: "q8" → model_quantized.onnx).
  return [
    "config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "special_tokens_map.json",
    "sentencepiece.bpe.model",
    "onnx/model_quantized.onnx",
  ];
}

// ---------------------------------------------------------------------------
// Atomic write helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Sweep a model's cache directory to remove leftover `*.tmp` files and any
 * zero-byte `.onnx` / `.json` files. These are unambiguous evidence of a
 * crashed previous run and must not be allowed to satisfy "already cached".
 */
export async function purgePartialFiles(modelDir: string): Promise<number> {
  if (!existsSync(modelDir)) return 0;
  let removed = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const isTmp = entry.name.endsWith(".tmp");
      const isSuspectExt = /\.(onnx|json)$/.test(entry.name);
      let shouldRemove = isTmp;
      if (!shouldRemove && isSuspectExt) {
        try {
          shouldRemove = statSync(full).size === 0;
        } catch {
          shouldRemove = false;
        }
      }
      if (shouldRemove) {
        try {
          unlinkSync(full);
          removed++;
        } catch {
          /* best effort */
        }
      }
    }
  };
  walk(modelDir);
  return removed;
}

/**
 * Download a single file via HTTPS, writing first to `<dest>.tmp` and renaming
 * on success. Throws on any non-2xx response or zero-byte body.
 */
export async function atomicDownload(url: string, dest: string): Promise<number> {
  await fsp.mkdir(dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp`;
  // Clean up any prior `.tmp` from a previous crash.
  try {
    await fsp.unlink(tmp);
  } catch {
    /* noop */
  }

  const res = await fetch(url, {
    headers: { "User-Agent": "mcp-chest-memory/fetch-model" },
    redirect: "follow",
  });
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  }
  let bytes = 0;
  await new Promise<void>((resolve, reject) => {
    const ws = createWriteStream(tmp);
    // Node's fetch returns a web ReadableStream; convert to Node Readable.
    const nodeStream = Readable.fromWeb(res.body as unknown as import("node:stream/web").ReadableStream);
    nodeStream.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
    });
    nodeStream.on("error", reject);
    ws.on("error", reject);
    ws.on("finish", resolve);
    nodeStream.pipe(ws);
  });
  if (bytes === 0) {
    try {
      await fsp.unlink(tmp);
    } catch {
      /* noop */
    }
    throw new Error(`empty response body for ${url}`);
  }
  await fsp.rename(tmp, dest);
  return bytes;
}

function hfFileUrl(modelId: string, filename: string): string {
  const base = process.env.HF_ENDPOINT?.replace(/\/+$/, "") ?? "https://huggingface.co";
  return `${base}/${modelId}/resolve/main/${filename}`;
}

/**
 * Resolve the cache directory used for a given model. transformers.js stores
 * files at `<cacheRoot>/<repoId>/<filename>` so we match that layout.
 */
export function modelDirFor(modelId: string): string {
  return join(modelCacheDir(), modelId);
}

// ---------------------------------------------------------------------------
// Progress reporter — minimum 1s granularity (FR-034)
// ---------------------------------------------------------------------------

class ProgressReporter {
  private lastEmit = 0;
  constructor(private readonly silent: boolean) {}
  emit(line: string, force = false): void {
    if (this.silent) return;
    const now = Date.now();
    if (!force && now - this.lastEmit < 1000) return;
    this.lastEmit = now;
    process.stderr.write(line.endsWith("\n") ? line : `${line}\n`);
  }
}

// ---------------------------------------------------------------------------
// Core orchestration
// ---------------------------------------------------------------------------

async function fetchOne(
  modelId: string,
  filename: string,
  force: boolean,
  reporter: ProgressReporter,
): Promise<ModelFetchResult> {
  const dest = join(modelDirFor(modelId), filename);
  const t0 = Date.now();
  if (!force) {
    try {
      const st = await fsp.stat(dest);
      if (st.size > 0) {
        reporter.emit(`[cached]     ${modelId}/${filename} (${formatBytes(st.size)})`, true);
        return {
          model_id: modelId,
          filename,
          status: "cached",
          bytes: st.size,
          duration_ms: Date.now() - t0,
        };
      }
    } catch {
      /* file missing → download */
    }
  } else {
    try {
      await fsp.unlink(dest);
    } catch {
      /* noop */
    }
  }
  reporter.emit(`[download]   ${modelId}/${filename} ...`, true);
  try {
    const bytes = await atomicDownload(hfFileUrl(modelId, filename), dest);
    const dur = Date.now() - t0;
    reporter.emit(
      `[downloaded] ${modelId}/${filename} (${formatBytes(bytes)}, ${(dur / 1000).toFixed(1)}s)`,
      true,
    );
    return { model_id: modelId, filename, status: "downloaded", bytes, duration_ms: dur };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      model_id: modelId,
      filename,
      status: "failed",
      bytes: 0,
      duration_ms: Date.now() - t0,
      error: msg,
    };
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * Programmatic entry point. Returns an exit code so callers can plug into
 * `chest-index fetch-model` without spawning a subprocess.
 *
 * Tests can capture the structured `ModelFetchReport` via `runFetchModelDetailed`
 * (below) which returns the report alongside the exit code without going
 * through stdout.
 */
export async function runFetchModel(args: FetchModelArgs): Promise<number> {
  const { code, report } = await runFetchModelDetailed(args);
  if (args.json) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
  }
  return code;
}

/** Test-friendly variant: also returns the structured report. */
export async function runFetchModelDetailed(
  args: FetchModelArgs,
): Promise<{ code: number; report: ModelFetchReport }> {
  const env = validateEnv();
  const started_at = new Date().toISOString();

  // Resolve target model(s).
  if (args.modelId) process.env.CHEST_EMBED_MODEL = args.modelId;
  const provider = activeProvider();
  const primary = args.modelId ?? provider.model;
  const models: string[] = [primary];
  if (args.reranker || env.CHEST_RERANK_ENABLED) {
    if (!models.includes(env.CHEST_RERANK_MODEL)) models.push(env.CHEST_RERANK_MODEL);
  }
  if (args.reranker && !models.includes(RERANKER_MODEL_ID)) {
    // `--reranker` flag forces the canonical reranker even if env var unset.
    if (!models.includes(RERANKER_MODEL_ID)) models.push(RERANKER_MODEL_ID);
  }

  const reporter = new ProgressReporter(args.json === true);
  reporter.emit(`[chest] cache directory: ${modelCacheDir()}`, true);
  reporter.emit(`[chest] models: ${models.join(", ")}`, true);

  // Ensure base cache dir exists.
  mkdirSync(modelCacheDir(), { recursive: true });

  const results: ModelFetchResult[] = [];
  for (const modelId of models) {
    const dir = modelDirFor(modelId);
    mkdirSync(dir, { recursive: true });
    // Pre-pass: purge leftover `.tmp` and zero-byte files (FR-032).
    const removed = await purgePartialFiles(dir);
    if (removed > 0) {
      reporter.emit(`[chest] purged ${removed} partial file(s) from ${dir}`, true);
    }
    const files = filesForModel(modelId);
    for (const filename of files) {
      const r = await fetchOne(modelId, filename, args.force === true, reporter);
      results.push(r);
    }
  }

  const finished_at = new Date().toISOString();
  const failures = results.filter((r) => r.status === "failed");
  const total_bytes = results.reduce((acc, r) => acc + r.bytes, 0);
  const exit_code = failures.length === 0 ? 0 : 1;

  const report: ModelFetchReport = {
    started_at,
    finished_at,
    models,
    results,
    total_bytes,
    exit_code,
  };

  if (!args.json) {
    process.stderr.write(
      `[chest] total ${formatBytes(total_bytes)} / ${results.length} files / ${failures.length} failed\n`,
    );
    if (failures.length > 0) {
      process.stderr.write(
        `[chest] FAILED files:\n` +
          failures.map((f) => `  - ${f.model_id}/${f.filename}: ${f.error}`).join("\n") +
          `\n`,
      );
      process.stderr.write(
        `[chest] fix_hint: check network connectivity. If behind a proxy or firewall, set\n` +
          `        HF_ENDPOINT=<mirror-url> to use a Hugging Face mirror, or\n` +
          `        HF_HUB_OFFLINE=1 to suppress further download attempts.\n`,
      );
    }
  }

  return { code: exit_code, report };
}

// ---------------------------------------------------------------------------
// CLI entry — preserves the existing `chest-fetch-model` bin behavior.
// ---------------------------------------------------------------------------

function parseCliArgs(argv: string[]): FetchModelArgs {
  const out: FetchModelArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--json") out.json = true;
    else if (v === "--reranker") out.reranker = true;
    else if (v === "--force") out.force = true;
    else if (v === "--model" && argv[i + 1]) {
      out.modelId = argv[++i];
    }
  }
  return out;
}

// Only run main when invoked directly (not when imported by fetch-model-cmd).
const invokedDirectly = (() => {
  try {
    const argv1 = process.argv[1] ?? "";
    return /fetch-model(\.[cm]?js|\.ts)?$/.test(argv1);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  runFetchModel(parseCliArgs(process.argv.slice(2)))
    .then((code) => process.exit(code))
    .catch((e) => {
      logger.error({ err: e instanceof Error ? e.message : String(e) }, "fetch-model fatal");
      process.stderr.write(`[chest] fatal: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    });
}
