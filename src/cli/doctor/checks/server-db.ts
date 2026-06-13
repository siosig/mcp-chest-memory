// Server doctor: SQLite database checks (existence / integrity / journal mode /
// table presence / writability).
//
// These run by querying the backend's `GET /diagnostics/db` endpoint rather
// than opening the DB from the doctor host. The doctor host may be an older
// Node without `node:sqlite` and does not know the container's data-volume
// path; the server computes everything with its live Prisma connection and the
// correct DB file, and the doctor just reads the JSON. See
// src/http/routes/diagnostics.ts.

import type { CheckResult } from "../types.js";
import { resolvePort, fetchWithTimeout, authHeaders } from "./server-http.js";
import { runCheck } from "../types.js";

type PartialResult = Omit<CheckResult, "id" | "title" | "category" | "duration_ms">;

const REQUIRED_TABLES = ["memories", "memories_fts", "entities"] as const;

interface DbDiagnostics {
  db_path: string;
  exists: boolean;
  size_bytes: number | null;
  integrity_check: string | null;
  journal_mode: string | null;
  tables_present: string[];
  missing_tables: string[];
  writable: boolean;
  error?: string;
}

type DiagOutcome =
  | { ok: true; data: DbDiagnostics }
  | { ok: false; result: PartialResult };

/** Fetch `/diagnostics/db` from the container's published port. */
async function fetchDiagnostics(container: string, timeoutSec: number): Promise<DiagOutcome> {
  const port = resolvePort(container);
  if (!port.ok) return { ok: false, result: port.result };
  const url = `http://${port.info.host}:${port.info.port}/diagnostics/db`;
  const r = await fetchWithTimeout(url, timeoutSec, authHeaders());
  if (!r.ok) {
    return {
      ok: false,
      result: {
        status: "fail",
        message: `GET ${url} failed: ${r.error}`,
        fix_hint:
          "Verify the server is reachable and runs feature 014 (the /diagnostics/db endpoint). Upgrade the server image if missing.",
      },
    };
  }
  if (r.status === 404) {
    return {
      ok: false,
      result: {
        status: "fail",
        message: `GET ${url} → 404 (endpoint not implemented).`,
        fix_hint: "Upgrade the server to a version that implements /diagnostics/db (feature 014).",
      },
    };
  }
  if (r.status === 401 || r.status === 403) {
    return {
      ok: false,
      result: {
        status: "fail",
        message: `GET ${url} → ${r.status} (authentication failed).`,
        fix_hint: "Set CHEST_API_TOKEN in the doctor's environment to match the server's token.",
      },
    };
  }
  if (r.status !== 200) {
    return {
      ok: false,
      result: {
        status: "fail",
        message: `GET ${url} → ${r.status}`,
        fix_hint: "Inspect server logs with `docker logs <container>`.",
      },
    };
  }
  let data: DbDiagnostics;
  try {
    data = JSON.parse(r.text) as DbDiagnostics;
  } catch (err) {
    return {
      ok: false,
      result: {
        status: "fail",
        message: `GET ${url} returned non-JSON body: ${err instanceof Error ? err.message : String(err)}`,
        fix_hint: "Server returned a malformed /diagnostics/db body; upgrade the server.",
      },
    };
  }
  return { ok: true, data };
}

function dbExistsResult(d: DbDiagnostics): PartialResult {
  if (!d.exists) {
    return {
      status: "fail",
      message: `Database file not found: ${d.db_path}`,
      fix_hint:
        "Start the server once to apply migrations, or run `chest-index up` to bootstrap the DB.",
    };
  }
  if (d.size_bytes === 0) {
    return {
      status: "fail",
      message: `Database file is empty (0 bytes): ${d.db_path}`,
      fix_hint: "Re-create the DB by restarting the server with a writable data directory.",
    };
  }
  return {
    status: "ok",
    message: `Database file present (${d.size_bytes ?? "?"} bytes): ${d.db_path}`,
    fix_hint: "",
  };
}

function dbIntegrityResult(d: DbDiagnostics): PartialResult {
  if (d.error) {
    return {
      status: "fail",
      message: `integrity_check failed to run: ${d.error}`,
      fix_hint: "Inspect the SQLite file with `sqlite3 <path> 'PRAGMA integrity_check;'`.",
    };
  }
  if (d.integrity_check === "ok") {
    return { status: "ok", message: "PRAGMA integrity_check = ok.", fix_hint: "" };
  }
  return {
    status: "fail",
    message: `PRAGMA integrity_check returned '${d.integrity_check ?? "(no row)"}'.`,
    fix_hint:
      "Stop the server, back up the DB file, then run `sqlite3 <db> '.recover' | sqlite3 <new-db>` to repair.",
  };
}

function dbJournalModeResult(d: DbDiagnostics): PartialResult {
  if (d.error) {
    return {
      status: "fail",
      message: `journal_mode query failed: ${d.error}`,
      fix_hint: "Inspect the DB connection settings.",
    };
  }
  if (d.journal_mode === "wal") {
    return { status: "ok", message: "journal_mode = wal.", fix_hint: "" };
  }
  return {
    status: "warn",
    message: `journal_mode = '${d.journal_mode ?? "(unknown)"}' (expected 'wal').`,
    fix_hint:
      "Restart the server so it re-applies `PRAGMA journal_mode=WAL`, or set it manually: `sqlite3 <db> 'PRAGMA journal_mode=WAL;'`.",
  };
}

function dbTablesResult(d: DbDiagnostics): PartialResult {
  if (d.error) {
    return {
      status: "fail",
      message: `Failed to list tables: ${d.error}`,
      fix_hint: "Verify the DB file is reachable and the schema migration ran.",
    };
  }
  const present = new Set(d.tables_present);
  const missing = REQUIRED_TABLES.filter((t) => !present.has(t));
  if (missing.length === 0) {
    return {
      status: "ok",
      message: `All required tables present (${REQUIRED_TABLES.join(", ")}).`,
      fix_hint: "",
    };
  }
  return {
    status: "fail",
    message: `Missing tables: ${missing.join(", ")}.`,
    fix_hint: "Re-run migrations: `chest-index migrate` (or restart the server to auto-apply).",
  };
}

function dbWritableResult(d: DbDiagnostics): PartialResult {
  if (d.writable) {
    return { status: "ok", message: "BEGIN/ROLLBACK succeeded — DB is writable.", fix_hint: "" };
  }
  return {
    status: "fail",
    message: `Database is not writable${d.error ? `: ${d.error}` : "."}`,
    fix_hint:
      "Fix ownership/permissions of the data directory and DB file (e.g. `chown -R 993:993 <data-dir>` to match the container uid).",
  };
}

/**
 * Run all five DB checks from a single `/diagnostics/db` fetch. Returns one
 * CheckResult per id so the orchestrator can spread them in place. If the
 * fetch itself fails, every check reports the same connection failure.
 */
export async function runDbChecks(container: string, timeoutSec: number): Promise<CheckResult[]> {
  const ids: Array<{ id: string; title: string }> = [
    { id: "server.db.exists", title: "Database file present" },
    { id: "server.db.integrity", title: "PRAGMA integrity_check" },
    { id: "server.db.journal_mode", title: "Journal mode is WAL" },
    { id: "server.db.tables", title: "Core tables present" },
    { id: "server.db.writable", title: "Database writable" },
  ];

  const diag = await fetchDiagnostics(container, timeoutSec);
  if (!diag.ok) {
    // Same connection failure for every db check — wrap via runCheck so each
    // gets an id/title/duration and the schema invariants hold.
    return Promise.all(
      ids.map((m) => runCheck(m.id, m.title, "db", async () => diag.result)),
    );
  }

  const d = diag.data;
  const builders: PartialResult[] = [
    dbExistsResult(d),
    dbIntegrityResult(d),
    dbJournalModeResult(d),
    dbTablesResult(d),
    dbWritableResult(d),
  ];
  return Promise.all(ids.map((m, i) => runCheck(m.id, m.title, "db", async () => builders[i])));
}
