// Server doctor: container environment variable presence checks.
//
// SECURITY: never copy the actual token value into message / fix_hint /
// process output. We only report the *shape* (set / empty / dummy).

import type { CheckResult } from "../types.js";
import { dockerInspect } from "./server-docker.js";

type PartialResult = Omit<CheckResult, "id" | "title" | "category" | "duration_ms">;

/** Known dummy values that indicate the operator never customised the token. */
const DUMMY_TOKEN_VALUES = new Set(["", "changeme", "token", "your-token", "xxx", "TODO", "todo"]);

interface ContainerEnv {
  [key: string]: string;
}

function readEnv(name: string): { ok: true; env: ContainerEnv } | { ok: false; result: PartialResult } {
  const inspect = dockerInspect(name);
  if (!inspect.ok) return { ok: false, result: inspect.result };
  const lines = inspect.data.Config?.Env ?? [];
  const env: ContainerEnv = {};
  for (const line of lines) {
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    env[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return { ok: true, env };
}

/**
 * Verify `CHEST_API_TOKEN` is set to a non-dummy value inside the container.
 * Never logs the token value itself.
 */
export async function checkEnvToken(container: string): Promise<PartialResult> {
  const r = readEnv(container);
  if (!r.ok) return r.result;
  const value = r.env["CHEST_API_TOKEN"];
  if (value === undefined) {
    return {
      status: "fail",
      message: "CHEST_API_TOKEN is not set in the container environment.",
      fix_hint:
        "Set CHEST_API_TOKEN in `deploy/docker/compose.override.yaml` (env or env_file) and restart the container.",
    };
  }
  if (DUMMY_TOKEN_VALUES.has(value)) {
    return {
      status: "fail",
      message: "CHEST_API_TOKEN is set to a known dummy/default value.",
      fix_hint:
        "Generate a strong token (e.g. `openssl rand -hex 32`) and set CHEST_API_TOKEN in compose.override.yaml; restart the container.",
    };
  }
  // Avoid leaking even the length; just confirm presence.
  return {
    status: "ok",
    message: "CHEST_API_TOKEN is set (value redacted).",
    fix_hint: "",
  };
}

/**
 * The REST backend owns the SQLite store through Prisma, and Prisma is disabled
 * when CHEST_MODE=remote (src/lib/db/prisma-client.ts). So a server container
 * MUST run in local mode (the default); remote would break storage. Whether the
 * server *embeds* is a separate axis (CHEST_SYNC_EMBED / CHEST_AUTO_MAINTENANCE),
 * surfaced via /capabilities' server_has_embedder — not here.
 */
export async function checkEnvMode(container: string): Promise<PartialResult> {
  const r = readEnv(container);
  if (!r.ok) return r.result;
  const mode = r.env["CHEST_MODE"];
  if (mode === undefined || mode === "local") {
    return {
      status: "ok",
      message: `CHEST_MODE=${mode ?? "local (default)"} — backend uses its local SQLite store.`,
      fix_hint: "",
    };
  }
  return {
    status: "fail",
    message: `CHEST_MODE='${mode}'. The REST backend must run in 'local' mode; 'remote' disables Prisma and breaks storage.`,
    fix_hint:
      "Remove CHEST_MODE (it defaults to local) or set CHEST_MODE=local in compose.override.yaml, then restart the container.",
  };
}
