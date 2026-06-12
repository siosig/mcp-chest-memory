import { homedir } from "node:os";
import { join } from "node:path";
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
  /** Embedding provider. "local" runs fully offline after model download. */
  CHEST_EMBEDDING_PROVIDER: z.enum(["local", "gemini"]).default("local"),
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

/** Resolve the data directory (created lazily by callers). */
export function dataDir(env: Env = validateEnv()): string {
  return env.CHEST_DATA_DIR ?? join(homedir(), ".chest-memory");
}

/** Resolve the SQLite file path used in local mode and by the REST backend. */
export function dbPath(env: Env = validateEnv()): string {
  return env.CHEST_DB_PATH ?? join(dataDir(env), "chest.db");
}

/** Directory where the local embedding model is cached. */
export function modelCacheDir(env: Env = validateEnv()): string {
  return join(dataDir(env), "models");
}

/** Reset the cached env (test helper). */
export function resetEnvCache(): void {
  cached = undefined;
}
