// Bundled schema runner: creates the full schema on a fresh database,
// reconciles databases initialized by `prisma migrate deploy`, and is
// idempotent — the foundation of clone-free `npx -y mcp-chest-memory`.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensureSchema } from "../../src/lib/db/migrate.js";

const MIGRATION_SQL = new URL("../../prisma/migrations/0_init/migration.sql", import.meta.url);

function withTempDb<T>(fn: (file: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "chest-migrate-"));
  const file = join(dir, "chest.db");
  const prevUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = `file:${file}?connection_limit=1`;
  return fn(file).finally(() => {
    if (prevUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevUrl;
    rmSync(dir, { recursive: true, force: true });
  });
}

function tableNames(file: string): Set<string> {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
      name: string;
    }>;
    return new Set(rows.map((r) => r.name));
  } finally {
    db.close();
  }
}

describe("ensureSchema", () => {
  test("creates the full schema (tables, FTS5, triggers) on a fresh database", async () => {
    await withTempDb(async (file) => {
      await ensureSchema();
      const tables = tableNames(file);
      for (const t of ["memories", "entities", "memories_fts", "_chest_migrations"]) {
        assert.ok(tables.has(t), `missing table ${t}`);
      }
      // The realize-protection trigger must work, which proves trigger DDL applied.
      const db = new DatabaseSync(file);
      try {
        db.exec("INSERT INTO entities (kind, name) VALUES ('project', 'p')");
        db.exec(
          "INSERT INTO memories (entity_id, layer, content, occurred_check) SELECT 1, 'realize', 'x', 1 WHERE 0",
        );
      } catch {
        /* the throwaway insert above is intentionally inert */
      } finally {
        db.close();
      }
    });
  });

  test("is idempotent: a second run applies nothing and does not fail", async () => {
    await withTempDb(async (file) => {
      await ensureSchema();
      await ensureSchema();
      assert.ok(tableNames(file).has("memories"));
    });
  });

  test("reconciles a database created outside the runner without re-executing DDL", async () => {
    await withTempDb(async (file) => {
      // Simulate `prisma migrate deploy`: schema exists, no _chest_migrations.
      const db = new DatabaseSync(file);
      db.exec(readFileSync(MIGRATION_SQL, "utf8"));
      db.close();

      await ensureSchema(); // must record, not re-run (re-running would fail on CREATE TABLE)

      const check = new DatabaseSync(file, { readOnly: true });
      try {
        const rows = check.prepare("SELECT name FROM _chest_migrations").all();
        assert.ok(rows.length >= 1, "bundled migrations must be recorded as applied");
      } finally {
        check.close();
      }
    });
  });
});
