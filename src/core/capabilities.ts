// Server capabilities advertised at GET /capabilities.
//
// The client uses these to (1) negotiate API version, (2) decide whether to
// embed locally vs. rely on the server, and (3) detect clock drift via
// server_time. Keep the surface area tiny and stable — every field is a
// contract observed by external clients (CLI, MCP, future SDKs).

import pkg from "../../package.json" with { type: "json" };
import { validateEnv, serverEmbedsEnabled, type Env } from "../utils/env.js";

/**
 * Bump when introducing a breaking change to any client-facing HTTP contract.
 *
 * Tied to `package.json#version` because the server and the bundled CLI are
 * always released together: a backend that ships these new endpoints already
 * implies the same release line on the client (`chest-index pending-resync`
 * lives in the same package). Older clients (without pending-resync) will
 * naturally compare strictly less and be rejected by the version gate.
 */
export const MIN_REQUIRED_CLIENT_VERSION = pkg.version;

/** Stable feature flags surfaced to clients; only add, never rename. */
export const SERVER_FEATURES = [
  "client-embed",
  "pending-resync",
  "memories-pending-list",
  "memories-embedding-update",
] as const;

export type ServerFeature = (typeof SERVER_FEATURES)[number];

export interface ServerCapabilities {
  api_version: string;
  features: string[];
  server_has_embedder: boolean;
  min_required_client_version: string;
  server_time: string;
}

/**
 * Build the capabilities payload. `server_has_embedder` reflects whether the
 * backend actually embeds new memories (write-time sync embed or the maintenance
 * sweep), NOT CHEST_MODE — the backend always runs local mode (remote disables
 * Prisma), so a server is opted out of embedding via CHEST_SYNC_EMBED=0 +
 * CHEST_AUTO_MAINTENANCE=0. When false, remote clients embed locally and push
 * vectors (FR-042 / spec 014). See serverEmbedsEnabled.
 */
export function getServerCapabilities(env: Env = validateEnv()): ServerCapabilities {
  return {
    api_version: pkg.version,
    features: [...SERVER_FEATURES],
    server_has_embedder: serverEmbedsEnabled(env),
    min_required_client_version: MIN_REQUIRED_CLIENT_VERSION,
    server_time: new Date().toISOString(),
  };
}
