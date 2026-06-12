// Unit tests for buildSnapshot.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSnapshot, SNAPSHOT_BUDGET_BYTES, type SnapshotInput } from "../../src/lib/snapshot/build.js";

function input(partial: Partial<SnapshotInput>): SnapshotInput {
  return {
    sessionId: "s1",
    fileEdits: [],
    realizes: [],
    goals: [],
    learnings: [],
    ...partial,
  };
}

test("all inputs empty → empty string (no snapshot generated)", () => {
  assert.equal(buildSnapshot(input({})), "");
});

test("tier order: files → errors → goals → decisions", () => {
  const text = buildSnapshot(
    input({
      fileEdits: [{ filePath: "src/a.ts", opCount: 3 }],
      realizes: [{ content: "FK constraint で migration 失敗", importance: 0.85 }],
      goals: [{ content: "RRF 導入", importance: 0.8 }],
      learnings: [{ content: "exec form が安全", importance: 0.7 }],
    }),
  );
  const iFiles = text.indexOf("### Active files");
  const iErr = text.indexOf("### Unresolved errors");
  const iGoal = text.indexOf("### Goals");
  const iDec = text.indexOf("### Recent decisions");
  assert.ok(iFiles >= 0 && iErr > iFiles && iGoal > iErr && iDec > iGoal);
  assert.ok(text.includes("src/a.ts (3 edits)"));
});

test("empty tiers are omitted along with their heading", () => {
  const text = buildSnapshot(input({ goals: [{ content: "g", importance: 0.5 }] }));
  assert.ok(text.includes("### Goals"));
  assert.ok(!text.includes("### Active files"));
  assert.ok(!text.includes("### Unresolved errors"));
});

test("budget (2KB): output always stays within SNAPSHOT_BUDGET_BYTES", () => {
  const long = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      content: `長い記憶テキスト${i} `.repeat(30),
      importance: 0.9 - i * 0.01,
    }));
  const text = buildSnapshot(
    input({
      fileEdits: Array.from({ length: 30 }, (_, i) => ({ filePath: `src/very/long/path/file-${i}.ts`, opCount: 30 - i })),
      realizes: long(10),
      goals: long(10),
      learnings: long(10),
    }),
  );
  assert.ok(Buffer.byteLength(text, "utf8") <= SNAPSHOT_BUDGET_BYTES, `actual=${Buffer.byteLength(text, "utf8")}`);
});

test("tight budget: low-priority tier (decisions) is dropped first; files and errors are retained", () => {
  const fat = { content: "x".repeat(150), importance: 0.8 };
  const text = buildSnapshot(
    input({
      fileEdits: Array.from({ length: 10 }, (_, i) => ({ filePath: `src/f${i}.ts`, opCount: 1 })),
      realizes: [fat, fat, fat, fat, fat],
      goals: [fat, fat, fat, fat, fat],
      learnings: [fat, fat, fat, fat, fat],
    }),
    900, // small budget to trigger truncation
  );
  assert.ok(Buffer.byteLength(text, "utf8") <= 900);
  assert.ok(!text.includes("### Recent decisions"), "decisions tier must be dropped");
  assert.ok(text.includes("### Active files"), "files tier must be retained");
  assert.ok(text.includes("### Unresolved errors"), "errors tier must be retained");
});

test("items within a tier are sorted by importance descending", () => {
  const text = buildSnapshot(
    input({
      realizes: [
        { content: "LOW importance realize", importance: 0.3 },
        { content: "HIGH importance realize", importance: 0.95 },
      ],
    }),
  );
  assert.ok(text.indexOf("HIGH") < text.indexOf("LOW"));
});

test("long items are truncated with a trailing ellipsis", () => {
  const text = buildSnapshot(input({ goals: [{ content: "あ".repeat(500), importance: 0.8 }] }));
  assert.ok(text.includes("…"));
  assert.ok(Buffer.byteLength(text, "utf8") < 1000);
});
