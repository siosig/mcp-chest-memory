// Self-contained schema runner.
//
// `npx -y mcp-chest-memory` must work without a repository checkout, so the
// server applies the bundled prisma/migrations/*/migration.sql files itself
// on startup instead of relying on the Prisma CLI. node:sqlite is used only
// here, as a DDL executor (it handles multi-statement scripts including
// triggers); all application queries go through Prisma.
//
// Applied migrations are tracked in _chest_migrations. A database that was
// initialized by `prisma migrate deploy` (no _chest_migrations yet, but the
// schema exists) is reconciled by recording the bundled migrations without
// executing them.

import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { dbPath } from "../../utils/env.js";

function resolveDbFile(): string {
  const url = process.env.DATABASE_URL;
  if (url?.startsWith("file:")) {
    const noScheme = url.slice("file:".length);
    return noScheme.split("?")[0];
  }
  return dbPath();
}

function migrationsDir(): string | null {
  // dist/lib/db/migrate.js -> <package root>/prisma/migrations
  // (the same layout in the npm package and in a repository checkout)
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = join(here, "..", "..", "..", "prisma", "migrations");
  return existsSync(candidate) ? candidate : null;
}

/** Apply any bundled migrations that this database has not seen yet. */
export async function ensureSchema(): Promise<void> {
  const dir = migrationsDir();
  if (!dir) return; // packaging problem; the next query will surface it loudly

  const names = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, "migration.sql")))
    .map((d) => d.name)
    .sort();
  if (names.length === 0) return;

  const file = resolveDbFile();
  mkdirSync(dirname(file), { recursive: true });

  const db = new DatabaseSync(file);
  try {
    db.exec(
      `CREATE TABLE IF NOT EXISTS _chest_migrations (
         name TEXT PRIMARY KEY,
         applied_at INTEGER NOT NULL DEFAULT (unixepoch())
       )`,
    );
    const appliedRows = db.prepare("SELECT name FROM _chest_migrations").all() as Array<{
      name: string;
    }>;
    const applied = new Set(appliedRows.map((r) => r.name));

    const schemaExists =
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories'").get() !==
      undefined;
    // First reconciliation of a pre-runner database: record, don't execute.
    const reconcileOnly = schemaExists && applied.size === 0;

    const record = db.prepare("INSERT INTO _chest_migrations (name) VALUES (?)");
    for (const name of names) {
      if (applied.has(name)) continue;
      if (reconcileOnly) {
        record.run(name);
        continue;
      }
      const sql = readFileSync(join(dir, name, "migration.sql"), "utf8");
      db.exec("BEGIN");
      try {
        db.exec(sql);
        record.run(name);
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw new Error(`migration ${name} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } finally {
    db.close();
  }
}
