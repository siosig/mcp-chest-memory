#!/usr/bin/env node
// Initialize (or upgrade) the SQLite schema. Idempotent; used by the
// installer, the bootstrap importer, and the Docker entrypoint. The MCP and
// REST servers also run the same routine automatically on startup.

import { ensureSchema } from "../lib/db/migrate.js";

await ensureSchema();
process.stderr.write("[chest] database schema is up to date\n");
