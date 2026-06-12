// Hook wiring into Claude Code settings.json: idempotent add/update/remove,
// preservation of foreign settings, and corrupt-file safety.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildNodeHookSpecs,
  buildNpxHookSpecs,
  wireHooks,
  removeHooks,
  HOOK_EVENTS,
} from "../../src/lib/hooks-install.js";

function settingsIn(dir: string): string {
  return join(dir, "settings.json");
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

const SPECS = buildNodeHookSpecs({ distBinDir: "/opt/chest/dist/bin" });

test("buildNodeHookSpecs embeds env vars and absolute script paths", () => {
  const specs = buildNodeHookSpecs({
    distBinDir: "/opt/chest/dist/bin",
    dataDir: "/data/chest",
    dbPath: "/data/chest/chest.db",
  });
  assert.equal(specs.length, 3);
  const stop = specs.find((s) => s.event === "Stop");
  assert.ok(stop);
  assert.equal(
    stop.command,
    "CHEST_DATA_DIR=/data/chest CHEST_DB_PATH=/data/chest/chest.db node /opt/chest/dist/bin/sync-session.js",
  );
  const events = specs.map((s) => s.event).sort();
  assert.deepEqual(events, ["PreCompact", "SessionStart", "Stop"]);
});

test("buildNodeHookSpecs quotes paths with spaces", () => {
  const specs = buildNodeHookSpecs({ distBinDir: "/opt/my chest/dist/bin" });
  assert.ok(specs[0].command.includes("'/opt/my chest/dist/bin/"));
});

test("buildNpxHookSpecs uses registry bin names", () => {
  const cmds = buildNpxHookSpecs().map((s) => s.command);
  assert.deepEqual(cmds, [
    "npx -y chest-memory-sync",
    "npx -y chest-memory-precompact",
    "npx -y chest-memory-session-start",
  ]);
});

test("wireHooks creates settings.json with all three hooks", () => {
  const path = settingsIn(mkdtempSync(join(tmpdir(), "chest-hooks-")));
  const results = wireHooks(path, SPECS);
  assert.deepEqual(results.map((r) => r.action), ["added", "added", "added"]);
  const settings = readJson(path);
  for (const event of HOOK_EVENTS) {
    assert.equal(settings.hooks[event].length, 1);
    assert.equal(settings.hooks[event][0].hooks[0].type, "command");
  }
});

test("wireHooks is idempotent and updates a changed command in place", () => {
  const path = settingsIn(mkdtempSync(join(tmpdir(), "chest-hooks-")));
  wireHooks(path, SPECS);

  const again = wireHooks(path, SPECS);
  assert.deepEqual(again.map((r) => r.action), ["unchanged", "unchanged", "unchanged"]);

  const moved = buildNodeHookSpecs({ distBinDir: "/elsewhere/dist/bin", dataDir: "/d2" });
  const updated = wireHooks(path, moved);
  assert.deepEqual(updated.map((r) => r.action), ["updated", "updated", "updated"]);

  const settings = readJson(path);
  for (const event of HOOK_EVENTS) {
    assert.equal(settings.hooks[event].length, 1); // replaced, not duplicated
    assert.ok(settings.hooks[event][0].hooks[0].command.startsWith("CHEST_DATA_DIR=/d2 "));
  }
});

test("wireHooks preserves unrelated settings and foreign hooks", () => {
  const path = settingsIn(mkdtempSync(join(tmpdir(), "chest-hooks-")));
  writeFileSync(
    path,
    JSON.stringify({
      permissions: { allow: ["Bash(ls:*)"] },
      hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: "other-tool" }] }] },
    }),
  );
  wireHooks(path, SPECS);
  const settings = readJson(path);
  assert.deepEqual(settings.permissions, { allow: ["Bash(ls:*)"] });
  assert.equal(settings.hooks.Stop.length, 2);
  assert.equal(settings.hooks.Stop[0].hooks[0].command, "other-tool");
});

test("wireHooks throws on corrupt settings.json and leaves it untouched", () => {
  const path = settingsIn(mkdtempSync(join(tmpdir(), "chest-hooks-")));
  writeFileSync(path, "{ not json");
  assert.throws(() => wireHooks(path, SPECS));
  assert.equal(readFileSync(path, "utf8"), "{ not json");
});

test("removeHooks deletes only chest entries and supports both command forms", () => {
  const path = settingsIn(mkdtempSync(join(tmpdir(), "chest-hooks-")));
  writeFileSync(
    path,
    JSON.stringify({
      hooks: {
        Stop: [
          { matcher: "", hooks: [{ type: "command", command: "other-tool" }] },
          { matcher: "", hooks: [{ type: "command", command: "npx -y chest-memory-sync" }] },
        ],
        PreCompact: [
          { matcher: "", hooks: [{ type: "command", command: "node /x/dist/bin/precompact.js" }] },
        ],
      },
    }),
  );
  const results = removeHooks(path);
  assert.deepEqual(results.map((r) => `${r.event}:${r.action}`), ["Stop:removed", "PreCompact:removed"]);
  const settings = readJson(path);
  assert.equal(settings.hooks.Stop.length, 1);
  assert.equal(settings.hooks.Stop[0].hooks[0].command, "other-tool");
  assert.ok(!("PreCompact" in settings.hooks));
});

test("removeHooks is a no-op on missing or corrupt settings.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "chest-hooks-"));
  const missing = settingsIn(dir);
  assert.deepEqual(removeHooks(missing), []);
  assert.equal(existsSync(missing), false);

  writeFileSync(missing, "{ not json");
  assert.deepEqual(removeHooks(missing), []);
  assert.equal(readFileSync(missing, "utf8"), "{ not json");
});
