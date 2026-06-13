// Integration test for `chest-index doctor client` building blocks.
//
// Covers the three Acceptance Scenarios from spec.md US2 that do not require
// a live remote server: all-ok, rules missing, and MCP not registered. The
// checks are exercised directly (not through the CLI dispatcher) so that
// the test stays hermetic — we fabricate a fake `$HOME` and `$cwd` and
// inject them via the documented `opts.home` / `opts.cwd` parameters.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkMcpProject, checkMcpUser } from "../../src/cli/doctor/checks/client-mcp.js";
import { checkRulesExists } from "../../src/cli/doctor/checks/client-rules.js";
import { checkSkillsDir } from "../../src/cli/doctor/checks/client-skills.js";

let workRoot = "";
let homeAllOk = "";
let cwdAllOk = "";
let homeNoRules = "";
let homeNoSkill = "";
let cwdNoMcp = "";

async function writeMcpJson(path: string, withChest: boolean): Promise<void> {
  const body = withChest
    ? { mcpServers: { "chest-memory": { command: "npx", args: ["-y", "mcp-chest-memory@latest"] } } }
    : { mcpServers: { other: { command: "noop" } } };
  await writeFile(path, JSON.stringify(body, null, 2), "utf8");
}

async function setupAllOk(): Promise<void> {
  await mkdir(join(homeAllOk, ".claude", "rules"), { recursive: true });
  await mkdir(join(homeAllOk, ".claude", "skills", "chest-memory"), { recursive: true });
  await writeFile(
    join(homeAllOk, ".claude", "rules", "mcp-chest-memory.md"),
    "# chest-memory rules (test fixture)\n",
    "utf8",
  );
  await writeFile(
    join(homeAllOk, ".claude", "skills", "chest-memory", "SKILL.md"),
    "# chest-memory skill (test fixture)\n",
    "utf8",
  );
  await writeFile(join(homeAllOk, ".claude.json"), JSON.stringify({ mcpServers: { "chest-memory": {} } }, null, 2), "utf8");
  await writeMcpJson(join(cwdAllOk, ".mcp.json"), true);
}

async function setupNoRules(): Promise<void> {
  // .claude exists but no rules dir / no rules file.
  await mkdir(join(homeNoRules, ".claude"), { recursive: true });
  await mkdir(join(homeNoRules, ".claude", "skills", "chest-memory"), { recursive: true });
  await writeFile(
    join(homeNoRules, ".claude", "skills", "chest-memory", "SKILL.md"),
    "# skill\n",
    "utf8",
  );
}

async function setupNoSkill(): Promise<void> {
  await mkdir(join(homeNoSkill, ".claude", "rules"), { recursive: true });
  await writeFile(
    join(homeNoSkill, ".claude", "rules", "mcp-chest-memory.md"),
    "# rules\n",
    "utf8",
  );
}

async function setupNoMcp(): Promise<void> {
  // .mcp.json present but without chest-memory entry.
  await writeMcpJson(join(cwdNoMcp, ".mcp.json"), false);
}

before(async () => {
  workRoot = await mkdtemp(join(tmpdir(), "chest-doctor-client-"));
  homeAllOk = join(workRoot, "home-ok");
  cwdAllOk = join(workRoot, "cwd-ok");
  homeNoRules = join(workRoot, "home-no-rules");
  homeNoSkill = join(workRoot, "home-no-skill");
  cwdNoMcp = join(workRoot, "cwd-no-mcp");
  await Promise.all([
    mkdir(homeAllOk, { recursive: true }),
    mkdir(cwdAllOk, { recursive: true }),
    mkdir(homeNoRules, { recursive: true }),
    mkdir(homeNoSkill, { recursive: true }),
    mkdir(cwdNoMcp, { recursive: true }),
  ]);
  await setupAllOk();
  await setupNoRules();
  await setupNoSkill();
  await setupNoMcp();
});

after(async () => {
  if (workRoot) await rm(workRoot, { recursive: true, force: true });
});

describe("doctor client — file-based checks", () => {
  test("all-ok: project MCP, user MCP, rules, and skill all pass", async () => {
    const project = await checkMcpProject({ cwd: cwdAllOk });
    assert.equal(project.status, "ok", `expected ok, got ${project.status}: ${project.message}`);

    const user = await checkMcpUser({ home: homeAllOk });
    assert.equal(user.status, "ok", `expected ok, got ${user.status}: ${user.message}`);

    const rules = await checkRulesExists({ home: homeAllOk });
    assert.equal(rules.status, "ok", `expected ok, got ${rules.status}: ${rules.message}`);

    const skill = await checkSkillsDir({ home: homeAllOk });
    assert.equal(skill.status, "ok", `expected ok, got ${skill.status}: ${skill.message}`);
  });

  test("missing rules file is reported as fail with setup hint", async () => {
    const rules = await checkRulesExists({ home: homeNoRules });
    assert.equal(rules.status, "fail");
    assert.match(rules.fix_hint, /chest-memory-setup/, "fix_hint should point at the setup command");
  });

  test("missing skill is reported as fail with setup hint", async () => {
    const skill = await checkSkillsDir({ home: homeNoSkill });
    assert.equal(skill.status, "fail");
    assert.match(skill.fix_hint, /chest-memory-setup/);
  });

  test("project .mcp.json without chest-memory entry fails", async () => {
    const project = await checkMcpProject({ cwd: cwdNoMcp });
    assert.equal(project.status, "fail");
    assert.match(project.message, /not registered/i);
  });

  test("absent project .mcp.json is skipped, not failed", async () => {
    const project = await checkMcpProject({ cwd: workRoot }); // no .mcp.json at this level
    assert.equal(project.status, "skip");
  });

  test("absent user ~/.claude.json fails", async () => {
    const user = await checkMcpUser({ home: homeNoRules }); // we never wrote .claude.json here
    assert.equal(user.status, "fail");
    assert.match(user.fix_hint, /chest-memory-setup/);
  });
});
