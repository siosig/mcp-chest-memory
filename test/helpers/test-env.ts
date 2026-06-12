// Test bootstrap: provision a throwaway SQLite database BEFORE the Prisma
// client module is evaluated (ESM import order guarantees this when this
// module is imported first). The schema is applied by executing the init
// migration directly — node:sqlite is used only here, as a DDL runner; all
// application code accesses the database through Prisma.

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const dir = mkdtempSync(join(tmpdir(), "chest-test-"));
const file = join(dir, "chest.db");

const migrationUrl = new URL("../../prisma/migrations/0_init/migration.sql", import.meta.url);
const db = new DatabaseSync(file);
db.exec(readFileSync(migrationUrl, "utf8"));
db.close();

process.env.DATABASE_URL = `file:${file}`;
process.env.CHEST_DB_PATH = file;
process.env.CHEST_DATA_DIR = dir;
// Never trigger a model download or background maintenance from unit tests.
process.env.CHEST_SYNC_EMBED = "0";
process.env.CHEST_AUTO_MAINTENANCE = "0";

export const TEST_DB_PATH = file;
