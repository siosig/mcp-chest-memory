#!/usr/bin/env node
// install-skill: copies the bundled SKILL.md into ~/.claude/skills/chest-memory/
// so Claude Code can auto-invoke chest-memory based on user intent.
//
// Usage:
//   npx chest-memory-install-skill           (safe — won't overwrite without --force)
//   npx chest-memory-install-skill --force   (overwrite existing file)
//   npx chest-memory-install-skill --dry-run (show what would happen)
//
// Why: installing the MCP server alone doesn't teach Claude Code WHEN to call
// recall/remember/read_smart/etc. The skill provides trigger phrases such as
// "before", "last time", "same error again", as well as new task start and
// file-edit events, so the agent fires automatically without the user having
// to type "use chest-memory".

import { mkdirSync, existsSync, copyFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const force = args.includes('--force') || args.includes('-f');
const dryRun = args.includes('--dry-run');
const showHelp = args.includes('--help') || args.includes('-h');

if (showHelp) {
  console.log(`chest-memory-install-skill

Install the chest-memory Claude Code skill into ~/.claude/skills/chest-memory/.

Options:
  --force, -f    Overwrite an existing skill file
  --dry-run      Show what would happen without writing
  --help, -h     This message

After installation, ensure the MCP server is registered in Claude Code:
  claude mcp add -s user chest-memory -- npx -y mcp-chest-memory

The skill references tools as chest_remember / chest_recall etc.; they are
exposed by the chest-memory MCP server regardless of the registration name.`);
  process.exit(0);
}

// The bundled skill lives next to us in dist/skill/ after build
const __filename = fileURLToPath(import.meta.url);
const skillSrc = join(dirname(__filename), '..', 'skill', 'SKILL.md');

if (!existsSync(skillSrc)) {
  console.error(`[error] bundled skill not found at ${skillSrc}`);
  console.error('This is a packaging bug — make sure the project was built (npm run build).');
  process.exit(1);
}

const targetDir = join(homedir(), '.claude', 'skills', 'chest-memory');
const targetFile = join(targetDir, 'SKILL.md');
const exists = existsSync(targetFile);

if (dryRun) {
  console.log('[dry-run] Would install skill:');
  console.log(`  source: ${skillSrc}`);
  console.log(`  target: ${targetFile}`);
  console.log(`  exists: ${exists ? 'yes (would NOT overwrite without --force)' : 'no'}`);
  process.exit(0);
}

mkdirSync(targetDir, { recursive: true });

if (exists && !force) {
  try {
    const bundled = readFileSync(skillSrc, 'utf8');
    const installed = readFileSync(targetFile, 'utf8');
    if (bundled === installed) {
      console.log(`[ok] Skill already installed and up to date:`);
      console.log(`     ${targetFile}`);
      process.exit(0);
    }
  } catch {
    /* fall through */
  }
  console.log(`[skip] A skill already exists at ${targetFile}`);
  console.log('       The bundled version differs. To overwrite, run:');
  console.log('       chest-memory-install-skill --force');
  process.exit(0);
}

copyFileSync(skillSrc, targetFile);
console.log(`[ok] Skill installed: ${targetFile}`);
console.log('');
console.log('Next steps:');
console.log('  1. Ensure the chest-memory MCP server is registered:');
console.log('       claude mcp add -s user chest-memory -- npx -y mcp-chest-memory');
console.log('');
console.log('  2. Restart Claude Code (the skill auto-loads on next turn).');
console.log('');
console.log('  3. Test by saying something like:');
console.log('       "How did we solve this before?"');
console.log('       "Same error again"');
console.log('       "Remember: I prefer TypeScript over JavaScript"');
console.log('');
console.log('The skill will trigger and call recall/remember automatically.');
