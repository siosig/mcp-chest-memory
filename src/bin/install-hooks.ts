#!/usr/bin/env node
// Wire (or remove) the chest-memory Claude Code hooks in ~/.claude/settings.json:
//   Stop         → chest-memory-sync           (auto-capture the session)
//   PreCompact   → chest-memory-precompact     (save a work-state snapshot)
//   SessionStart → chest-memory-session-start  (restore the snapshot)
//   UserPromptSubmit → chest-memory-user-prompt-submit (remote auto-recall)
//
// Usage:
//   install-hooks.js [--data-dir DIR] [--db-path PATH] [--settings PATH]
//   install-hooks.js --remove [--settings PATH]
//   install-hooks.js --dry-run ...
//
// Commands run `npx -y -p mcp-chest-memory@latest <bin>`, so the hooks always
// run the published package regardless of where Claude Code is started from
// and follow npm releases without a reinstall. Idempotent: re-running updates
// entries in place and never duplicates them.

import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  buildNodeHookSpecs,
  wireHooks,
  removeHooks,
  type HookResult,
} from '../lib/hooks-install.js';

const args = process.argv.slice(2);

function optValue(flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) {
    console.error(`${flag} requires a value`);
    process.exit(1);
  }
  return v;
}

if (args.includes('--help') || args.includes('-h')) {
  console.log(`install-hooks — wire the chest-memory Claude Code hooks

Options:
  --data-dir DIR   embed CHEST_DATA_DIR=DIR into the hook commands
  --db-path PATH   embed CHEST_DB_PATH=PATH into the hook commands
  --settings PATH  settings.json location (default: ~/.claude/settings.json)
  --remove         remove all chest-memory hook entries instead of adding
  --dry-run        report what would change without writing`);
  process.exit(0);
}

const dryRun = args.includes('--dry-run');
const remove = args.includes('--remove');
const settingsPath = optValue('--settings') ?? join(homedir(), '.claude', 'settings.json');

function report(results: HookResult[], verb: string): void {
  if (results.length === 0) {
    console.log(`[chest] hooks: nothing to ${verb}`);
    return;
  }
  for (const r of results) console.log(`[chest] hook ${r.event}: ${r.action}`);
}

try {
  if (remove) {
    if (dryRun) {
      console.log('[chest] [dry-run] would remove chest-memory hooks from', settingsPath);
    } else {
      report(removeHooks(settingsPath), 'remove');
    }
  } else {
    const specs = buildNodeHookSpecs({
      dataDir: optValue('--data-dir'),
      dbPath: optValue('--db-path'),
    });
    if (dryRun) {
      for (const s of specs) console.log(`[chest] [dry-run] ${s.event}: ${s.command}`);
    } else {
      report(wireHooks(settingsPath, specs), 'add');
    }
  }
} catch (e: unknown) {
  console.error(
    `[chest] failed to update ${settingsPath}: ${e instanceof Error ? e.message : String(e)}`,
  );
  console.error('[chest] the file was left untouched — fix its JSON and re-run');
  process.exit(1);
}
