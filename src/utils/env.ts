import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

// Central runtime configuration. Every deployment profile (single-PC local,
// LAN/WAN remote) is expressed through these variables only — the tool
// semantics never change across profiles.
export const EnvSchema = z.object({
  /** Execution mode of the MCP stdio server. */
  CHEST_MODE: z.enum(["local", "remote"]).default("local"),
  /** Root directory for local data (SQLite file, model cache). */
  CHEST_DATA_DIR: z.string().optional(),
  /** SQLite database file path. Defaults to <data dir>/chest.db. */
  CHEST_DB_PATH: z.string().optional(),
  /** Backend base URL for remote mode (e.g. http://192.168.1.10:8765). */
  CHEST_REMOTE_URL: z.string().optional(),
  /** Shared bearer token. Required by the REST backend and by remote mode. */
  CHEST_API_TOKEN: z.string().optional(),
  /** REST backend listen port. */
  CHEST_PORT: z.coerce.number().int().positive().default(8765),
  /**
   * Fallback allow-list for chest_read_smart when the MCP client does not declare
   * the roots capability. Colon-separated absolute paths on POSIX, semicolon-separated
   * on Windows (same convention as PATH). Ignored when roots/list succeeds.
   */
  CHEST_ROOTS: z.string().optional(),
  /**
   * REST backend listen host. Defaults to 0.0.0.0 (unchanged behavior); set to
   * 127.0.0.1 to bind loopback only when a reverse proxy fronts the backend.
   */
  CHEST_BIND_HOST: z.string().default("0.0.0.0"),
  /** Min seconds between background maintenance passes (decay/sweeps). */
  CHEST_MAINTENANCE_INTERVAL_SEC: z.coerce.number().int().positive().default(600),
  /** Set to "0" to disable write-triggered background maintenance. */
  CHEST_AUTO_MAINTENANCE: z.string().optional(),
  /** Embedding model ID. Must match a key in the provider registry. Default: Xenova/bge-m3. */
  CHEST_EMBED_MODEL: z.string().default("Xenova/bge-m3"),
  /** Enable cross-encoder reranking after RRF fusion. Disabled by default. */
  CHEST_RERANK_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1")
    .pipe(z.boolean())
    .default(false),
  /** Reranker model ID. Only used when CHEST_RERANK_ENABLED=true. */
  CHEST_RERANK_MODEL: z.string().default("onnx-community/bge-reranker-v2-m3-ONNX"),
  /** Number of post-RRF candidates to pass to the reranker (1–200). */
  CHEST_RERANK_TOP_N: z.coerce.number().int().min(1).max(200).default(20),
  /** Hard timeout (ms) for reranker inference (100–30000). On expiry, pre-rerank order is used. */
  CHEST_RERANK_TIMEOUT_MS: z.coerce.number().int().min(100).max(30000).default(5000),
  /** Enable Sudachi tokenization in the memory write path for FTS. Enabled by default. */
  CHEST_FTS_TOKENIZE: z
    .string()
    .optional()
    .transform((v) => v !== "false" && v !== "0")
    .pipe(z.boolean())
    .default(true),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

export function validateEnv(): Env {
  if (cached) return cached;
  const result = EnvSchema.safeParse(process.env);
  if (!result.success) {
    process.stderr.write(
      `[chest-memory] env validation failed:\n${JSON.stringify(result.error.flatten(), null, 2)}\n`,
    );
    process.exit(1);
  }
  cached = result.data;
  return cached;
}

/** Reset the env cache. For testing only — allows env var changes to take effect between test suites. */
export function resetEnvCacheForTest(): void {
  cached = undefined;
}

/** Resolve the data directory (created lazily by callers). */
export function dataDir(env: Env = validateEnv()): string {
  return env.CHEST_DATA_DIR ?? join(homedir(), ".chest-memory");
}

/** Resolve the SQLite file path used in local mode and by the REST backend. */
export function dbPath(env: Env = validateEnv()): string {
  return env.CHEST_DB_PATH ?? join(dataDir(env), "chest.db");
}

/**
 * Root directory for all generated files (models, dict, logs, temp).
 * Equals dirname(dbPath()), which is identical to dataDir() for default installs.
 * When CHEST_DB_PATH points to a custom location, generated files land beside it.
 */
export function chestRootDir(env: Env = validateEnv()): string {
  return dirname(dbPath(env));
}

/** Directory where embedding model ONNX files are cached. */
export function modelCacheDir(env: Env = validateEnv()): string {
  return join(chestRootDir(env), "models");
}

/** Directory where tokenizer dictionary files (Sudachi) are cached. */
export function dictCacheDir(env: Env = validateEnv()): string {
  return join(chestRootDir(env), "dict");
}

