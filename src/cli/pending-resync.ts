// chest-index pending-resync — bulk client-side embedding push.
//
// Pulls pending memories from the server in cursor-paged batches, embeds them
// locally (bge-m3), and writes vectors back via POST /memories/:id/embedding.
// Idempotent at the memory.id granularity; safe to re-run after partial runs.
// Contract: specs/014-doctor-healthcheck/contracts/cli-subcommands.md §4

import { createHash } from "node:crypto";
import pkg from "../../package.json" with { type: "json" };
import {
  CapabilitiesClient,
  type PendingMemoryItem,
} from "../http/client.js";
import { embedTextClient, isModelCacheMissing } from "../lib/embedding/client-embed.js";
import { activeProvider } from "../lib/embedding/provider.js";
import { validateEnv } from "../utils/env.js";
import { lt } from "../utils/semver.js";
import { logger } from "../utils/logger.js";

export interface PendingResyncArgs {
  json: boolean;
  dryRun: boolean;
  batchSize: number;
  concurrency: number;
  maxRetry: number;
  remoteUrl: string;
  timeout: number;
}

interface BatchResult {
  batch_index: number;
  memory_ids: number[];
  succeeded: number[];
  skipped: Array<{ id: number; reason: string }>;
  failed: Array<{ id: number; error: string }>;
  duration_ms: number;
}

interface ResyncReport {
  started_at: string;
  finished_at: string;
  batches: BatchResult[];
  total_processed: number;
  total_skipped: number;
  total_failed: number;
  exit_code: 0 | 1 | 2;
}

function sha1Hex(text: string): string {
  return createHash("sha1").update(text, "utf8").digest("hex");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function processOne(
  client: CapabilitiesClient,
  item: PendingMemoryItem,
  modelId: string,
  maxRetry: number,
): Promise<
  | { kind: "ok"; id: number }
  | { kind: "skip"; id: number; reason: string }
  | { kind: "fail"; id: number; error: string }
> {
  const text = item.text_for_embedding || item.content;
  if (!text || text.trim().length === 0) {
    return { kind: "skip", id: item.id, reason: "empty text_for_embedding" };
  }

  const embed = await embedTextClient(text);
  if (!(embed instanceof Float32Array)) {
    if (isModelCacheMissing(embed)) {
      return { kind: "fail", id: item.id, error: "MODEL_CACHE_MISSING" };
    }
    return { kind: "skip", id: item.id, reason: embed.message };
  }
  const vec = Array.from(embed);
  const sha = sha1Hex(text);

  let attempt = 0;
  while (true) {
    try {
      await client.updateEmbedding(item.id, vec, modelId, sha);
      return { kind: "ok", id: item.id };
    } catch (e) {
      const code = (e as { code?: string }).code ?? "";
      const message = e instanceof Error ? e.message : String(e);

      // 409 → re-embed once. The text content in our hand may already be the
      // newest version (we don't re-fetch); the next run will pick it up if
      // the row was updated on the server.
      if (code === "CONTENT_CHANGED") {
        if (attempt === 0) {
          attempt++;
          continue;
        }
        return { kind: "fail", id: item.id, error: `409 content_changed: ${message}` };
      }
      // 404 / NOT_FOUND / auth → no retry
      if (code === "NOT_FOUND" || code === "UNAUTHORIZED") {
        return { kind: "fail", id: item.id, error: message };
      }
      // 5xx and network errors → exponential backoff
      attempt++;
      if (attempt > maxRetry) {
        return { kind: "fail", id: item.id, error: message };
      }
      const backoff = Math.min(30_000, 250 * 2 ** (attempt - 1));
      await sleep(backoff);
    }
  }
}

async function processBatch(
  client: CapabilitiesClient,
  items: PendingMemoryItem[],
  modelId: string,
  concurrency: number,
  maxRetry: number,
  batchIndex: number,
): Promise<BatchResult> {
  const startedAt = Date.now();
  const memory_ids = items.map((i) => i.id);
  const succeeded: number[] = [];
  const skipped: Array<{ id: number; reason: string }> = [];
  const failed: Array<{ id: number; error: string }> = [];

  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      const item = items[idx];
      if (!item) return;
      const r = await processOne(client, item, modelId, maxRetry);
      if (r.kind === "ok") succeeded.push(r.id);
      else if (r.kind === "skip") skipped.push({ id: r.id, reason: r.reason });
      else failed.push({ id: r.id, error: r.error });
    }
  }
  const workers = Array.from({ length: Math.max(1, concurrency) }, () => worker());
  await Promise.all(workers);

  return {
    batch_index: batchIndex,
    memory_ids,
    succeeded,
    skipped,
    failed,
    duration_ms: Date.now() - startedAt,
  };
}

function writeText(msg: string): void {
  process.stdout.write(msg.endsWith("\n") ? msg : `${msg}\n`);
}

function resolveBaseUrl(args: PendingResyncArgs): string {
  if (args.remoteUrl) return args.remoteUrl;
  const env = validateEnv();
  return env.CHEST_REMOTE_URL ?? "";
}

export async function runPendingResync(args: PendingResyncArgs): Promise<number> {
  const env = validateEnv();
  const token = env.CHEST_API_TOKEN ?? "";
  const baseUrl = resolveBaseUrl(args);
  if (!baseUrl) {
    process.stderr.write(
      "[pending-resync] CHEST_REMOTE_URL is not set (use --remote-url or env)\n",
    );
    return 2;
  }
  if (!token) {
    process.stderr.write("[pending-resync] CHEST_API_TOKEN is required\n");
    return 2;
  }

  const client = new CapabilitiesClient({
    baseUrl,
    token,
    timeoutMs: args.timeout * 1000,
  });

  // 1) capabilities + version check
  let caps;
  try {
    caps = await client.getCapabilities();
  } catch (e) {
    process.stderr.write(
      `[pending-resync] capabilities request failed: ${
        e instanceof Error ? e.message : String(e)
      }\n`,
    );
    return 2;
  }
  const selfVersion = pkg.version;
  if (lt(selfVersion, caps.min_required_client_version)) {
    process.stderr.write(
      `[pending-resync] client version ${selfVersion} is older than ` +
        `server's min_required_client_version ${caps.min_required_client_version}.\n` +
        "  fix: upgrade chest-memory (npm i -g mcp-chest-memory@latest)\n",
    );
    return 2;
  }

  if (!args.json) {
    writeText(
      `chest-index pending-resync (target=${baseUrl}, batch=${args.batchSize}, concurrency=${args.concurrency})\n`,
    );
    writeText(
      `Capabilities: api_version=${caps.api_version}, server_has_embedder=${caps.server_has_embedder}\n`,
    );
  }

  // 2) dry-run
  if (args.dryRun) {
    let head;
    try {
      head = await client.listPending(0, 1);
    } catch (e) {
      process.stderr.write(
        `[pending-resync] listPending failed: ${
          e instanceof Error ? e.message : String(e)
        }\n`,
      );
      return 2;
    }
    const eta = head.remaining * 0.4; // rough 0.4s per memory estimate (bge-m3 CPU)
    if (args.json) {
      writeText(
        JSON.stringify({
          dry_run: true,
          remaining: head.remaining,
          estimated_seconds: Math.round(eta),
        }),
      );
    } else {
      writeText(`pending=${head.remaining} estimated_time=${Math.round(eta)}s`);
    }
    return 0;
  }

  // 3) main loop
  const startedAt = new Date().toISOString();
  const provider = activeProvider();
  const batches: BatchResult[] = [];
  let cursor = 0;
  let batchIndex = 0;

  while (true) {
    let page;
    try {
      page = await client.listPending(cursor, args.batchSize);
    } catch (e) {
      process.stderr.write(
        `[pending-resync] listPending failed at cursor=${cursor}: ${
          e instanceof Error ? e.message : String(e)
        }\n`,
      );
      // Treat as fatal — partial progress remains in DB; user can re-run.
      break;
    }
    if (page.items.length === 0) break;

    batchIndex++;
    const batchResult = await processBatch(
      client,
      page.items,
      provider.model,
      args.concurrency,
      args.maxRetry,
      batchIndex,
    );
    batches.push(batchResult);

    if (!args.json) {
      writeText(
        `Batch ${batchIndex}  done=${batchResult.succeeded.length}  ` +
          `fail=${batchResult.failed.length}  skip=${batchResult.skipped.length}  ` +
          `(${(batchResult.duration_ms / 1000).toFixed(1)}s, ${page.remaining} remaining)`,
      );
    }

    if (page.next_cursor === 0 || page.next_cursor <= cursor) break;
    cursor = page.next_cursor;
  }

  const total_processed = batches.reduce((s, b) => s + b.succeeded.length, 0);
  const total_skipped = batches.reduce((s, b) => s + b.skipped.length, 0);
  const total_failed = batches.reduce((s, b) => s + b.failed.length, 0);
  const exit_code: 0 | 1 | 2 =
    total_failed > 0 ? 2 : total_skipped > 0 ? 1 : 0;

  const report: ResyncReport = {
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    batches,
    total_processed,
    total_skipped,
    total_failed,
    exit_code,
  };

  if (args.json) {
    writeText(JSON.stringify(report));
  } else {
    writeText("");
    writeText(
      `Total: processed=${total_processed}  skipped=${total_skipped}  ` +
        `failed=${total_failed}`,
    );
    writeText(`Exit code: ${exit_code}`);
  }

  logger.info({ total_processed, total_skipped, total_failed }, "pending-resync complete");
  return exit_code;
}
