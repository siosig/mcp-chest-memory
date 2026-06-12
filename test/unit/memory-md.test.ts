// Curated auto-memory markdown import: frontmatter parsing, MEMORY.md
// index exclusion, type→layer mapping, and idempotent DB import.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { parseMemoryMarkdown, buildMemoryContent, collectMemoryFiles, mapMemoryType } from "../../src/lib/memory-md.js";
import { importMemoryDir } from "../../src/lib/memory-md-import.js";
import { prisma, rawAll } from "../../src/lib/db/prisma-client.js";
import { resetDb } from "../helpers/db.js";

// --- parseMemoryMarkdown -----------------------------------------------------

test("parses flat frontmatter (name/description/type/originSessionId)", () => {
  const raw = [
    "---",
    "name: buildhost access via SSH",
    "description: judge the host first",
    "type: feedback",
    "originSessionId: fc2c354b-5dd1-43c0-b684-f441d515ba6f",
    "---",
    "Body line 1.",
    "",
    "Body line 2.",
  ].join("\n");
  const p = parseMemoryMarkdown(raw, "feedback_ssh.md");
  assert.ok(p);
  assert.equal(p.name, "buildhost access via SSH");
  assert.equal(p.description, "judge the host first");
  assert.equal(p.type, "feedback");
  assert.equal(p.originSessionId, "fc2c354b-5dd1-43c0-b684-f441d515ba6f");
  assert.equal(p.body, "Body line 1.\n\nBody line 2.");
});

test("parses nested metadata.type frontmatter", () => {
  const raw = [
    "---",
    "name: some-slug",
    "description: a summary",
    "metadata:",
    "  type: project",
    "---",
    "The fact.",
  ].join("\n");
  const p = parseMemoryMarkdown(raw, "some-slug.md");
  assert.ok(p);
  assert.equal(p.type, "project");
});

test("file without frontmatter falls back to file name, keeps body", () => {
  const p = parseMemoryMarkdown("Just a plain note.", "plain_note.md");
  assert.ok(p);
  assert.equal(p.name, "plain_note");
  assert.equal(p.type, null);
  assert.equal(p.body, "Just a plain note.");
});

test("empty body and no description → null (skipped)", () => {
  assert.equal(parseMemoryMarkdown("", "empty.md"), null);
  assert.equal(parseMemoryMarkdown("---\nname: x\ntype: user\n---\n\n", "empty2.md"), null);
});

test("quoted values are unquoted; indented keys outside metadata are ignored", () => {
  const raw = [
    "---",
    'name: "quoted name"',
    "other:",
    "  type: feedback",
    "description: 'single'",
    "---",
    "body",
  ].join("\n");
  const p = parseMemoryMarkdown(raw, "f.md");
  assert.ok(p);
  assert.equal(p.name, "quoted name");
  assert.equal(p.description, "single");
  assert.equal(p.type, null);
});

// --- buildMemoryContent --------------------------------------------------------

test("buildMemoryContent composes title + description + body and truncates", () => {
  const p = parseMemoryMarkdown("---\nname: t\ndescription: d\n---\nbody", "t.md");
  assert.ok(p);
  assert.equal(buildMemoryContent(p, 8000), "# t\nd\n\nbody");
  assert.equal(buildMemoryContent(p, 5), "# t\nd");
});

// --- mapMemoryType ---------------------------------------------------------------

test("type→layer/importance mapping", () => {
  assert.deepEqual(mapMemoryType("feedback"), { layer: "learning", importance: 0.7 });
  assert.deepEqual(mapMemoryType("user"), { layer: "context", importance: 0.6 });
  assert.deepEqual(mapMemoryType("project"), { layer: "context", importance: 0.6 });
  assert.deepEqual(mapMemoryType("reference"), { layer: "context", importance: 0.6 });
  assert.deepEqual(mapMemoryType("Feedback"), { layer: "learning", importance: 0.7 });
  assert.deepEqual(mapMemoryType(null), { layer: "context", importance: 0.5 });
  assert.deepEqual(mapMemoryType("weird"), { layer: "context", importance: 0.5 });
});

// --- collectMemoryFiles ---------------------------------------------------------

function makeProjectDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "chest-memmd-"));
  mkdirSync(join(dir, "memory"), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, "memory", name), content);
  }
  return dir;
}

const MEM_A = "---\nname: a\ndescription: da\ntype: feedback\n---\nfact a";
const MEM_B = "---\nname: b\ndescription: db\ntype: reference\n---\nfact b";
const INDEX = "# Memory Index\n\n- [a](a.md) — da\n- [b](b.md) — db";

test("collectMemoryFiles excludes MEMORY.md when individual files exist", () => {
  const dir = makeProjectDir({ "MEMORY.md": INDEX, "a.md": MEM_A, "b.md": MEM_B });
  const names = collectMemoryFiles(dir).map((f) => basename(f));
  assert.deepEqual(names, ["a.md", "b.md"]);
});

test("collectMemoryFiles falls back to MEMORY.md when it is the only file", () => {
  const dir = makeProjectDir({ "MEMORY.md": "Some inline memory content." });
  const names = collectMemoryFiles(dir).map((f) => basename(f));
  assert.deepEqual(names, ["MEMORY.md"]);
});

test("collectMemoryFiles returns [] when memory/ is missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "chest-memmd-"));
  assert.deepEqual(collectMemoryFiles(dir), []);
});

// --- importMemoryDir (DB) --------------------------------------------------------

interface MemRow {
  layer: string;
  importance: number;
  content: string;
  source: string;
}

test("importMemoryDir inserts memories with mapped layer/importance and source", async () => {
  await resetDb();
  const dir = makeProjectDir({ "MEMORY.md": INDEX, "a.md": MEM_A, "b.md": MEM_B });

  const res = await importMemoryDir(dir, "proj-x", false);
  assert.deepEqual(res, { files: 2, memories: 2 });

  const rows = await rawAll<MemRow>(prisma, "SELECT layer, importance, content, source FROM memories ORDER BY id");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].layer, "learning");
  assert.equal(rows[0].importance, 0.7);
  assert.equal(rows[0].content, "# a\nda\n\nfact a");
  const source = JSON.parse(rows[0].source);
  assert.equal(source.kind, "memory_file");
  assert.equal(source.file, "a.md");
  assert.equal(source.type, "feedback");
  assert.equal(source.session_id, `memory-md:${basename(dir)}`);
  assert.equal(rows[1].layer, "context");

  const events = await rawAll<{ kind: string }>(prisma, "SELECT kind FROM events");
  assert.deepEqual(events.map((e) => e.kind), ["memory_files_imported"]);
});

test("importMemoryDir is idempotent: re-run does not grow tables", async () => {
  await resetDb();
  const dir = makeProjectDir({ "a.md": MEM_A, "b.md": MEM_B });

  await importMemoryDir(dir, "proj-x", false);
  await importMemoryDir(dir, "proj-x", false);

  const mems = await rawAll<{ c: number }>(prisma, "SELECT COUNT(*) c FROM memories");
  assert.equal(mems[0].c, 2);
  const events = await rawAll<{ c: number }>(prisma, "SELECT COUNT(*) c FROM events WHERE kind='memory_files_imported'");
  assert.equal(events[0].c, 1);
  const entities = await rawAll<{ c: number }>(prisma, "SELECT COUNT(*) c FROM entities");
  assert.equal(entities[0].c, 1);
});

test("importMemoryDir dry-run writes nothing", async () => {
  await resetDb();
  const dir = makeProjectDir({ "a.md": MEM_A });

  const res = await importMemoryDir(dir, "proj-x", true);
  assert.deepEqual(res, { files: 1, memories: 1 });
  const mems = await rawAll<{ c: number }>(prisma, "SELECT COUNT(*) c FROM memories");
  assert.equal(mems[0].c, 0);
});
