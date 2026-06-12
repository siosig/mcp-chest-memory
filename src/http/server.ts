#!/usr/bin/env node
// REST backend entry point (chest-server). Runs inside the Docker container
// for LAN/WAN profiles, or directly on a host. Owns the SQLite database.

import "../utils/temporal.js";
import { serve } from "@hono/node-server";

import { createApp } from "./app.js";
import { ensurePrismaInitialized, shutdownPrisma } from "../lib/db/prisma-client.js";
import { validateEnv } from "../utils/env.js";
import { logger } from "../utils/logger.js";

const SERVER_VERSION = "1.0.0";

const env = validateEnv();

if (!env.CHEST_API_TOKEN) {
  process.stderr.write(
    "[chest-server] CHEST_API_TOKEN is required. Refusing to start without authentication.\n",
  );
  process.exit(1);
}

try {
  await ensurePrismaInitialized();
} catch (err: unknown) {
  process.stderr.write(`[chest-server] DB init failed: ${(err as Error).message}\n`);
  process.exit(1);
}

const app = createApp({ token: env.CHEST_API_TOKEN, version: SERVER_VERSION });

const server = serve({ fetch: app.fetch, port: env.CHEST_PORT, hostname: "0.0.0.0" }, (info) => {
  logger.info({ port: info.port, version: SERVER_VERSION }, "chest-server listening");
  process.stderr.write(`[chest-server] listening on :${info.port} (v${SERVER_VERSION})\n`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    server.close(() => {
      void shutdownPrisma().finally(() => process.exit(0));
    });
    // Fallback if in-flight connections refuse to drain.
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
