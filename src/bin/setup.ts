#!/usr/bin/env node
// setup: One-command setup for Chest Memory — the "Use Chest" installer.
//
// Usage:
//   npx chest-memory-setup          (interactive setup)
//   npx chest-memory-setup --yes    (accept all defaults, no prompts)
//   npx chest-memory-setup --dry-run
//
// Does three things:
//   1. Registers the MCP server with Claude Code
//   2. Installs the SKILL.md (agent trigger phrases)
//   3. Configures the hooks: Stop (auto-capture sessions), PreCompact and
//      SessionStart (work-state snapshot across context compaction)
//
// After setup, every Claude Code session:
//   - Auto-captures decisions, learnings, realizes to local memory
//   - Agent auto-recalls past context at task start (via SKILL.md triggers)
//   - "Use Chest" in any prompt forces a recall
//
// Why: Competing memory tools (claude-mem, etc.) are one-install-and-done.
// Our MCP approach gives more precision, but the setup was 3 manual steps.
// This command eliminates that friction entirely.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildNodeHookSpecs, wireHooks } from '../lib/hooks-install.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const autoYes = args.includes('--yes') || args.includes('-y');
const showHelp = args.includes('--help') || args.includes('-h');

if (showHelp) {
  console.log(`chest-memory-setup — One-command setup for Chest Memory

Usage:
  npx chest-memory-setup          Interactive setup
  npx chest-memory-setup --yes    Accept all defaults, no prompts
  npx chest-memory-setup --dry-run Show what would happen

What it does:
  1. Registers chest-memory MCP server with Claude Code
  2. Installs SKILL.md (teaches the agent when to recall/remember)
  3. Configures hooks: Stop (auto-capture), PreCompact/SessionStart
     (work-state snapshot across context compaction)

After setup, just chat with Claude Code normally.
Add "Use Chest" to any prompt to trigger memory recall.`);
  process.exit(0);
}

// ── Constants ────────────────────────────────────────────
const HOME = homedir();
const CLAUDE_DIR = join(HOME, '.claude');
const SETTINGS_PATH = join(CLAUDE_DIR, 'settings.json');
const SKILL_DIR = join(CLAUDE_DIR, 'skills', 'chest-memory');
const SKILL_TARGET = join(SKILL_DIR, 'SKILL.md');
const __filename = fileURLToPath(import.meta.url);
const SKILL_SRC = join(dirname(__filename), '..', 'skill', 'SKILL.md');

const SERVER_NAME = 'chest-memory';
const MCP_COMMAND = `claude mcp add -s user ${SERVER_NAME} -- npx -y mcp-chest-memory`;

const CHECK = '\x1b[32m✓\x1b[0m';
const SKIP = '\x1b[33m○\x1b[0m';
const FAIL = '\x1b[31m✗\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

console.log('');
console.log(`${BOLD}Chest Memory Setup${RESET}`);
console.log(`${DIM}Local-first cross-LLM memory · precision recall${RESET}`);
console.log('');

// ── Step 1: Register MCP server ──────────────────────────

console.log(`${BOLD}[1/3]${RESET} Registering MCP server...`);

let mcpAlreadyRegistered = false;
try {
  // Check if already registered by looking at settings.json or .claude.json
  for (const confFile of [SETTINGS_PATH, join(HOME, '.claude.json')]) {
    if (!existsSync(confFile)) continue;
    try {
      const conf = JSON.parse(readFileSync(confFile, 'utf8'));
      if (conf?.mcpServers?.[SERVER_NAME]) {
        mcpAlreadyRegistered = true;
        break;
      }
    } catch { /* ignore parse errors */ }
  }
} catch { /* ignore */ }

if (mcpAlreadyRegistered) {
  console.log(`  ${SKIP} MCP server '${SERVER_NAME}' already registered`);
} else if (dryRun) {
  console.log(`  ${DIM}[dry-run] Would run: ${MCP_COMMAND}${RESET}`);
} else {
  try {
    // Check if 'claude' CLI is available
    const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    if (which.status !== 0) {
      console.log(`  ${FAIL} 'claude' CLI not found. Install Claude Code first:`);
      console.log(`    https://docs.anthropic.com/en/docs/claude-code`);
      console.log(`  ${DIM}Then run this setup again.${RESET}`);
    } else {
      const r = spawnSync('claude', ['mcp', 'add', '-s', 'user', SERVER_NAME, '--', 'npx', '-y', 'mcp-chest-memory'], {
        encoding: 'utf8',
        timeout: 15000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      if (r.status === 0) {
        console.log(`  ${CHECK} MCP server registered as '${SERVER_NAME}'`);
      } else {
        // May fail if already exists with different config
        const stderr = (r.stderr || '').trim();
        if (stderr.includes('already exists') || stderr.includes('already registered')) {
          console.log(`  ${SKIP} MCP server '${SERVER_NAME}' already registered`);
        } else {
          console.log(`  ${FAIL} Registration failed: ${stderr || 'unknown error'}`);
          console.log(`  ${DIM}Manual: ${MCP_COMMAND}${RESET}`);
        }
      }
    }
  } catch (e: unknown) {
    console.log(`  ${FAIL} Error: ${e instanceof Error ? e.message : String(e)}`);
    console.log(`  ${DIM}Manual: ${MCP_COMMAND}${RESET}`);
  }
}
console.log('');

// ── Step 2: Install SKILL.md ─────────────────────────────

console.log(`${BOLD}[2/3]${RESET} Installing agent skill...`);

if (!existsSync(SKILL_SRC)) {
  console.log(`  ${FAIL} Bundled SKILL.md not found (packaging bug)`);
  console.log(`  ${DIM}Expected at: ${SKILL_SRC}${RESET}`);
} else if (dryRun) {
  console.log(`  ${DIM}[dry-run] Would copy to: ${SKILL_TARGET}${RESET}`);
} else {
  mkdirSync(SKILL_DIR, { recursive: true });

  let shouldWrite = true;
  if (existsSync(SKILL_TARGET)) {
    try {
      const existing = readFileSync(SKILL_TARGET, 'utf8');
      const bundled = readFileSync(SKILL_SRC, 'utf8');
      if (existing === bundled) {
        console.log(`  ${SKIP} Skill already installed and up to date`);
        shouldWrite = false;
      } else {
        // Newer version — overwrite
        console.log(`  ${DIM}Updating to latest version...${RESET}`);
      }
    } catch { /* fallthrough to write */ }
  }

  if (shouldWrite) {
    copyFileSync(SKILL_SRC, SKILL_TARGET);
    console.log(`  ${CHECK} Skill installed → ${SKILL_TARGET}`);
  }
}
console.log('');

// ── Step 3: Configure hooks ──────────────────────────────

console.log(`${BOLD}[3/3]${RESET} Configuring hooks (auto-capture + compaction snapshots)...`);

// Absolute node commands against this install's dist/bin. An `npx -y` form
// would re-resolve (and potentially re-download) a package on every hook
// invocation — and `chest-memory-sync` is a bin name, not a package name, so
// npx would actually resolve the wrong package.
const hookSpecs = buildNodeHookSpecs({ distBinDir: dirname(__filename) });
if (dryRun) {
  for (const spec of hookSpecs) {
    console.log(`  ${DIM}[dry-run] Would wire ${spec.event} → ${spec.command}${RESET}`);
  }
} else {
  try {
    for (const result of wireHooks(SETTINGS_PATH, hookSpecs)) {
      if (result.action === 'unchanged') {
        console.log(`  ${SKIP} ${result.event} hook already configured`);
      } else {
        console.log(`  ${CHECK} ${result.event} hook ${result.action} → ${SETTINGS_PATH}`);
      }
    }
  } catch (e: unknown) {
    console.log(`  ${FAIL} Could not update ${SETTINGS_PATH}: ${e instanceof Error ? e.message : String(e)}`);
    console.log(`  ${DIM}The file was left untouched — fix its JSON and re-run.${RESET}`);
  }
}
console.log('');

// ── Summary ──────────────────────────────────────────────

console.log(`${BOLD}Setup complete!${RESET}`);
console.log('');
console.log(`Chest Memory v1.0.0 — ${BOLD}breaking change notice${RESET}:`);
console.log(`  ${DIM}MCP tools are now namespaced with the chest_ prefix:${RESET}`);
console.log(`  ${DIM}chest_remember / chest_recall / chest_forget / chest_consolidate${RESET}`);
console.log(`  ${DIM}chest_update_memory / chest_list_entities / chest_recall_file / chest_read_smart${RESET}`);
console.log('');
console.log('How it works:');
console.log(`  ${DIM}• Every session is auto-captured (decisions, realizes, learnings)${RESET}`);
console.log(`  ${DIM}• Agent auto-recalls past context when starting a task${RESET}`);
console.log(`  ${DIM}• Memory is local-first (nothing leaves your machine)${RESET}`);
console.log(`  ${DIM}• Works across Claude Code, Cursor, ChatGPT (cross-LLM)${RESET}`);
console.log('');
console.log('Test by asking:');
console.log(`  ${BOLD}"How did we solve this before?"${RESET}`);
console.log(`  ${BOLD}"Same error again"${RESET}`);
console.log(`  ${BOLD}"Remember: I prefer TypeScript over JavaScript"${RESET}`);
console.log('');
console.log(`Or add ${BOLD}"Use Chest"${RESET} to any prompt to trigger memory recall.`);
console.log('');
