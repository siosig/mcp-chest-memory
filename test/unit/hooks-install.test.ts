// Hook wiring into Claude Code settings.json: idempotent add/update/remove,
// preservation of foreign settings, and corrupt-file safety.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildNodeHookSpecs,
  buildNodeHookSpecsRemote,
  wireHooks,
  removeHooks,
  HOOK_EVENTS,
} from "../../src/lib/hooks-install.js";
import { REMINDER_ONLY_USER_PROMPT_SUBMIT_COMMAND } from "../fixtures/hooks-install.js";

function settingsIn(dir: string): string {
  return join(dir, "settings.json");
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

const SPECS = buildNodeHookSpecs();

test("buildNodeHookSpecs embeds env vars and npx package commands", () => {
  const specs = buildNodeHookSpecs({
    dataDir: "/data/chest",
    dbPath: "/data/chest/chest.db",
  });
  assert.equal(specs.length, 4);
  const stop = specs.find((s) => s.event === "Stop");
  assert.ok(stop);
  assert.equal(
    stop.command,
    "CHEST_DATA_DIR=/data/chest CHEST_DB_PATH=/data/chest/chest.db npx -y -p mcp-chest-memory@latest chest-memory-sync",
  );
  const events = specs.map((s) => s.event).sort();
  assert.deepEqual(events, ["PreCompact", "SessionStart", "Stop", "UserPromptSubmit"]);
});

test("buildNodeHookSpecs emits a bare npx command without env vars", () => {
  const specs = buildNodeHookSpecs();
  assert.equal(
    specs.find((s) => s.event === "Stop")?.command,
    "npx -y -p mcp-chest-memory@latest chest-memory-sync",
  );
});

test("buildNodeHookSpecs quotes env values with spaces", () => {
  const specs = buildNodeHookSpecs({ dataDir: "/data/my chest" });
  assert.ok(specs[0].command.startsWith("CHEST_DATA_DIR='/data/my chest' npx -y -p "));
});

test("wireHooks migrates a legacy absolute-node entry to the npx command", () => {
  const path = settingsIn(mkdtempSync(join(tmpdir(), "chest-hooks-")));
  writeFileSync(
    path,
    JSON.stringify({
      hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: "node /opt/chest/dist/bin/sync-session.js" }] }] },
    }),
  );
  const results = wireHooks(path, SPECS);
  assert.equal(results.find((r) => r.event === "Stop")?.action, "updated");
  const settings = readJson(path);
  assert.equal(settings.hooks.Stop.length, 1);
  assert.equal(settings.hooks.Stop[0].hooks[0].command, "npx -y -p mcp-chest-memory@latest chest-memory-sync");
});

test("wireHooks creates settings.json with all managed hooks", () => {
  const path = settingsIn(mkdtempSync(join(tmpdir(), "chest-hooks-")));
  const results = wireHooks(path, SPECS);
  assert.deepEqual(results.map((r) => r.action), ["added", "added", "added", "added"]);
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
  assert.deepEqual(again.map((r) => r.action), ["unchanged", "unchanged", "unchanged", "unchanged"]);

  const moved = buildNodeHookSpecs({ dataDir: "/d2" });
  const updated = wireHooks(path, moved);
  assert.deepEqual(updated.map((r) => r.action), ["updated", "updated", "updated", "updated"]);

  const settings = readJson(path);
  for (const event of HOOK_EVENTS) {
    assert.equal(settings.hooks[event].length, 1); // replaced, not duplicated
    assert.ok(settings.hooks[event][0].hooks[0].command.startsWith("CHEST_DATA_DIR=/d2 "));
  }
});

test("buildNodeHookSpecsRemote embeds remote env in UserPromptSubmit", () => {
  const specs = buildNodeHookSpecsRemote({
    remoteUrl: "https://chest.example.com/chest-memory",
    apiToken: "token-1234567890",
  });
  const promptSubmit = specs.find((s) => s.event === "UserPromptSubmit");
  assert.ok(promptSubmit);
  assert.equal(
    promptSubmit.command,
    "CHEST_MODE=remote CHEST_REMOTE_URL='https://chest.example.com/chest-memory' CHEST_API_TOKEN=token-1234567890 npx -y -p mcp-chest-memory@latest chest-memory-user-prompt-submit",
  );
});

test("wireHooks replaces known reminder-only UserPromptSubmit entries", () => {
  const path = settingsIn(mkdtempSync(join(tmpdir(), "chest-hooks-")));
  writeFileSync(
    path,
    JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          { matcher: "", hooks: [{ type: "command", command: REMINDER_ONLY_USER_PROMPT_SUBMIT_COMMAND }] },
        ],
      },
    }),
  );
  const results = wireHooks(path, SPECS);
  assert.equal(results.find((r) => r.event === "UserPromptSubmit")?.action, "updated");
  const settings = readJson(path);
  assert.equal(settings.hooks.UserPromptSubmit.length, 1);
  assert.equal(settings.hooks.UserPromptSubmit[0].hooks[0].command, "npx -y -p mcp-chest-memory@latest chest-memory-user-prompt-submit");
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
