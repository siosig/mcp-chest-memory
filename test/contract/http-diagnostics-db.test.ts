// Contract: GET /diagnostics/db
// Server-side SQLite health probe consumed by `chest-index doctor server`.

import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { ensurePrismaInitialized } from "../../src/lib/db/prisma-client.js";
import { createApp } from "../../src/http/app.js";

const TOKEN = "test-token-32chars-aaaaaaaaaaaaaaaa";

before(async () => {
  await ensurePrismaInitialized();
});

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

describe("GET /diagnostics/db", () => {
  test("401 without bearer token", async () => {
    const app = createApp({ token: TOKEN, version: "test" });
    const res = await app.request("/diagnostics/db");
    assert.equal(res.status, 401);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "unauthorized");
  });

  test("401 with wrong token", async () => {
    const app = createApp({ token: TOKEN, version: "test" });
    const res = await app.request("/diagnostics/db", {
      headers: { authorization: "Bearer wrong-token" },
    });
    assert.equal(res.status, 401);
  });

  test("200 with valid token, schema-compliant body", async () => {
    const app = createApp({ token: TOKEN, version: "test" });
    const res = await app.request("/diagnostics/db", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as DbDiagnostics;
    assert.equal(typeof body.db_path, "string");
    assert.equal(typeof body.exists, "boolean");
    assert.ok(Array.isArray(body.tables_present));
    assert.ok(Array.isArray(body.missing_tables));
    assert.equal(typeof body.writable, "boolean");
  });

  test("on a healthy test DB: integrity ok, WAL, core tables present, writable", async () => {
    const app = createApp({ token: TOKEN, version: "test" });
    const res = await app.request("/diagnostics/db", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const body = (await res.json()) as DbDiagnostics;
    assert.equal(body.error, undefined, `unexpected error: ${body.error}`);
    assert.equal(body.exists, true);
    assert.equal(body.integrity_check, "ok");
    assert.equal(body.journal_mode, "wal");
    assert.equal(body.writable, true);
    for (const t of ["memories", "memories_fts", "entities"]) {
      assert.ok(body.tables_present.includes(t), `missing table in report: ${t}`);
    }
    assert.equal(body.missing_tables.length, 0);
  });
});
