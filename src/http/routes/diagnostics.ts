// GET /diagnostics/db — server-side SQLite health, computed inside the backend
// process using its live Prisma connection.
//
// Why this lives on the server rather than in the doctor CLI: the doctor runs
// on an operator's host, which may not have `node:sqlite` (Node < 22.5) and
// does not know the container's data-volume path. Running the PRAGMAs here uses
// the same connection (WAL, busy_timeout) the live server uses and always
// targets the correct database file. The doctor just GETs this JSON.

import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { existsSync, statSync } from "node:fs";
import {
  ensurePrismaInitialized,
  prisma,
  rawAll,
  rawGet,
  rawRun,
} from "../../lib/db/prisma-client.js";
import { dbPath } from "../../utils/env.js";
import { logger } from "../../utils/logger.js";

const REQUIRED_TABLES = ["memories", "memories_fts", "entities"] as const;

export interface DbDiagnostics {
  db_path: string;
  exists: boolean;
  size_bytes: number | null;
  integrity_check: string | null;
  journal_mode: string | null;
  tables_present: string[];
  missing_tables: string[];
  writable: boolean;
  /** Present only when a query failed; the doctor surfaces it as a fail. */
  error?: string;
}

export function createDiagnosticsRoute(token: string): Hono {
  const app = new Hono();
  app.use(
    "*",
    bearerAuth({
      token,
      invalidTokenMessage: { error: "unauthorized" },
      noAuthenticationHeaderMessage: { error: "unauthorized" },
      invalidAuthenticationHeaderMessage: { error: "unauthorized" },
    }),
  );

  app.get("/db", async (c) => {
    const path = dbPath();
    const out: DbDiagnostics = {
      db_path: path,
      exists: false,
      size_bytes: null,
      integrity_check: null,
      journal_mode: null,
      tables_present: [],
      missing_tables: [...REQUIRED_TABLES],
      writable: false,
    };
    try {
      out.exists = existsSync(path);
      if (out.exists) {
        try {
          out.size_bytes = statSync(path).size;
        } catch {
          /* size left null; surfaced via exists/size checks downstream */
        }
      }

      await ensurePrismaInitialized();

      const integ = await rawAll<{ integrity_check: string }>(prisma, "PRAGMA integrity_check");
      out.integrity_check = integ[0]?.integrity_check ?? null;

      const jm = await rawGet<{ journal_mode: string }>(prisma, "PRAGMA journal_mode");
      out.journal_mode = (jm?.journal_mode ?? "").toLowerCase() || null;

      const tbls = await rawAll<{ name: string }>(
        prisma,
        "SELECT name FROM sqlite_master WHERE type='table'",
      );
      out.tables_present = tbls.map((r) => r.name);
      out.missing_tables = REQUIRED_TABLES.filter((t) => !out.tables_present.includes(t));

      // Writability probe: open an explicit immediate transaction, rewrite the
      // current user_version to itself, then roll back — byte-identical DB.
      try {
        await rawRun(prisma, "BEGIN IMMEDIATE");
        try {
          const cur = await rawGet<{ user_version: number }>(prisma, "PRAGMA user_version");
          await rawRun(prisma, `PRAGMA user_version = ${cur?.user_version ?? 0}`);
          out.writable = true;
        } finally {
          await rawRun(prisma, "ROLLBACK");
        }
      } catch (e) {
        out.writable = false;
        logger.warn(
          { err: e instanceof Error ? e.message : String(e) },
          "diagnostics: writability probe failed",
        );
      }

      return c.json(out);
    } catch (e) {
      out.error = e instanceof Error ? e.message : String(e);
      logger.error({ err: out.error }, "diagnostics/db failed");
      // 200 with an `error` field: the doctor renders per-check fails from it,
      // which is more actionable than an opaque 500.
      return c.json(out);
    }
  });

  return app;
}
