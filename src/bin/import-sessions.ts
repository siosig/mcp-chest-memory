#!/usr/bin/env node
// Batch importer: scan Claude Code session JSONL files and curated auto-memory
// markdown files (memory/*.md) and populate chest-memory.
// Usage:
//   node dist/bin/import-sessions.js [project_dir ...]
//   node dist/bin/import-sessions.js --dry-run [project_dir ...]
//   node dist/bin/import-sessions.js --all                   (scans all ~/.claude/projects/*)
//   node dist/bin/import-sessions.js --session-file <path>   (single jsonl — used by hook)
//
// All inserts are IDEMPOTENT: existing data for a given session_id is wiped before re-insert.

import { readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { prisma, rawRun, lastInsertId, ensurePrismaInitialized, shutdownPrisma } from '../lib/db/prisma-client.js';
import { parseSessionFile, detectProjectName, type ParsedSession } from '../lib/session-parser.js';
import { extractSession, type ExtractionResult } from '../lib/session-extractor.js';
import { collectMemoryFiles } from '../lib/memory-md.js';
import { importMemoryDir, resolveProjectEntity } from '../lib/memory-md-import.js';
import { redactText } from '../lib/redact.js';

const CLAUDE_PROJECTS = join(homedir(), '.claude', 'projects');

// Schema is managed by `prisma migrate deploy`. If the DB is unreachable, exit 0 so the hook is not blocked.
async function ensureDbOrSkip(): Promise<void> {
  try {
    await ensurePrismaInitialized();
  } catch (err: unknown) {
    process.stderr.write(`[chest-memory-import] DB not ready: ${(err as Error).message} — import skipped.\n`);
    process.exit(0);
  }
}

function usage(): void {
  console.log(`Usage:
  node dist/bin/import-sessions.js [--dry-run] [--all | <projectDir> [<projectDir> ...]]
    --all         : scan every project under ~/.claude/projects/*
    --dry-run     : parse + extract but do not write to DB
    projectDir    : absolute path to a project dir (must contain *.jsonl files)`);
}

function collectJsonlFiles(projectDir: string): string[] {
  try {
    return readdirSync(projectDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => join(projectDir, f))
      .filter((p) => {
        try { return statSync(p).isFile(); } catch { return false; }
      });
  } catch {
    return [];
  }
}

// Idempotent wipe: remove all rows tied to a given session_id BEFORE re-inserting.
async function wipeSession(sessionId: string): Promise<{ memories: number; edits: number; events: number }> {
  const sidNeedle = `%"session_id":"${sessionId}"%`;
  const edits = await rawRun(prisma, 'DELETE FROM session_file_edits WHERE session_id = ?', sessionId);
  const memories = await rawRun(prisma, 'DELETE FROM memories WHERE source LIKE ?', sidNeedle);
  const events = await rawRun(prisma, 'DELETE FROM events WHERE payload LIKE ?', sidNeedle);
  return { memories, edits, events };
}

async function insertSessionData(
  projectEntityId: number,
  result: ExtractionResult,
  parsed: ParsedSession,
): Promise<{ memories: number; edits: number }> {
  const counts = { memories: 0, edits: 0 };
  await prisma.$transaction(
    async (tx) => {
      const memContentToId = new Map<string, number>();
      for (const m of result.memories) {
        // Redact credentials immediately before persistence.
        // The key in memContentToId uses the pre-redacted content so that
        // file_edits references resolve correctly.
        await rawRun(
          tx,
          'INSERT INTO memories (entity_id, layer, content, importance, source) VALUES (?, ?, ?, ?, ?)',
          projectEntityId, m.layer, redactText(m.content), m.importance, JSON.stringify(m.source),
        );
        memContentToId.set(m.content, await lastInsertId(tx));
        counts.memories++;
      }
      for (const fe of result.file_edits) {
        const memId = fe.memory_content ? memContentToId.get(fe.memory_content) ?? null : null;
        await rawRun(
          tx,
          'INSERT INTO session_file_edits (session_id, memory_id, file_path, operation, turn_uuid, context_snippet, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          fe.session_id, memId, fe.file_path, fe.operation, fe.turn_uuid ?? null, redactText(fe.context_snippet), fe.occurred_at,
        );
        counts.edits++;
      }
      await rawRun(
        tx,
        'INSERT INTO events (entity_id, kind, payload, occurred_at) VALUES (?, ?, ?, ?)',
        projectEntityId, 'session_imported',
        JSON.stringify({
          session_id: result.session_id,
          memories: result.memories.length,
          file_edits: result.file_edits.length,
          stats: result.stats,
        }),
        parsed.started_at || Math.floor(Date.now() / 1000),
      );
    },
    { timeout: 120_000, maxWait: 30_000 },
  );
  return counts;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) { usage(); return; }
  const dryRun = args.includes('--dry-run');
  const scanAll = args.includes('--all');
  const sessionFileIdx = args.indexOf('--session-file');
  const sessionFile = sessionFileIdx >= 0 ? args[sessionFileIdx + 1] : null;
  const projectArgs = args.filter((a, i) => !a.startsWith('--') && (sessionFileIdx < 0 || i !== sessionFileIdx + 1));

  // Single-file mode (used by the Stop hook)
  if (sessionFile) {
    if (!dryRun) await ensureDbOrSkip();

    let parsed;
    try { parsed = parseSessionFile(sessionFile); } catch (e: unknown) {
      console.error(`[error] cannot parse ${sessionFile}: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
    if (!parsed) {
      console.log(`[skip] empty or invalid session: ${sessionFile}`);
      return;
    }

    const projectName = detectProjectName(parsed) || 'unknown';
    const result = extractSession(parsed, projectName);

    if (dryRun) {
      console.log(`[dry] session ${result.session_id.slice(0, 8)} (${projectName}): ${result.memories.length} memories, ${result.file_edits.length} file_edits`);
      await importMemoryDir(dirname(sessionFile), projectName, true);
      return;
    }

    const wiped = await wipeSession(result.session_id);
    const projectEntityId = await resolveProjectEntity(projectName);
    const inserted = await insertSessionData(projectEntityId, result, parsed);

    console.log(`[ok] ${result.session_id.slice(0, 8)} (${projectName}): wiped ${wiped.memories}m/${wiped.edits}e/${wiped.events}ev → inserted ${inserted.memories}m/${inserted.edits}e`);

    // Keep the project's curated memory files in sync on every session end.
    const mem = await importMemoryDir(dirname(sessionFile), projectName, false);
    if (mem.files > 0) console.log(`[ok] memory files (${projectName}): ${mem.memories} imported`);
    await shutdownPrisma();
    return;
  }

  let projectDirs: string[] = [];
  if (scanAll) {
    try {
      projectDirs = readdirSync(CLAUDE_PROJECTS)
        .map((d) => join(CLAUDE_PROJECTS, d))
        .filter((p) => {
          try { return statSync(p).isDirectory(); } catch { return false; }
        });
    } catch (e) {
      console.error(`Cannot scan ${CLAUDE_PROJECTS}:`, e);
      process.exit(1);
    }
  } else {
    projectDirs = projectArgs;
  }

  if (projectDirs.length === 0) {
    usage();
    process.exit(1);
  }

  if (!dryRun) await ensureDbOrSkip();

  const agg = {
    projects: 0,
    sessions_parsed: 0,
    sessions_skipped: 0,
    memories_planned: 0,
    memories_inserted: 0,
    file_edits_inserted: 0,
    memory_files_imported: 0,
    errors: 0,
  };

  for (const projectDir of projectDirs) {
    const files = collectJsonlFiles(projectDir);
    const hasMemoryFiles = collectMemoryFiles(projectDir).length > 0;
    if (files.length === 0 && !hasMemoryFiles) { console.log(`[skip] no .jsonl or memory/*.md in ${projectDir}`); continue; }
    agg.projects++;

    const rawDirName = projectDir.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? 'unknown';
    const decodedParts = rawDirName.split('--').filter(Boolean);
    const dirName = decodedParts.length > 1 ? decodedParts[decodedParts.length - 1] : rawDirName;
    console.log(`\n=== Project: ${dirName} (${files.length} session files) ===`);

    for (const f of files) {
      let parsed;
      try { parsed = parseSessionFile(f); } catch (e: unknown) {
        agg.errors++;
        console.warn(`  [error] ${f}: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      if (!parsed) { agg.sessions_skipped++; continue; }

      const projectName = detectProjectName(parsed) || dirName;
      const result = extractSession(parsed, projectName);
      agg.sessions_parsed++;
      agg.memories_planned += result.memories.length;

      if (dryRun) {
        console.log(`  [dry] session ${result.session_id.slice(0, 8)} (${projectName}): ${result.memories.length} memories, ${result.file_edits.length} file_edits, stats=${JSON.stringify(result.stats)}`);
        continue;
      }

      try {
        const projectEntityId = await resolveProjectEntity(projectName);
        await wipeSession(result.session_id);
        const inserted = await insertSessionData(projectEntityId, result, parsed);
        agg.memories_inserted += inserted.memories;
        agg.file_edits_inserted += inserted.edits;
      } catch (e: unknown) {
        agg.errors++;
        console.warn(`  [tx error] ${f}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    try {
      const mem = await importMemoryDir(projectDir, dirName, dryRun);
      agg.memory_files_imported += mem.memories;
      if (!dryRun && mem.files > 0) console.log(`  [ok] memory files: ${mem.memories} imported`);
    } catch (e: unknown) {
      agg.errors++;
      console.warn(`  [tx error] memory files in ${projectDir}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`  projects:           ${agg.projects}`);
  console.log(`  sessions parsed:    ${agg.sessions_parsed}`);
  console.log(`  sessions skipped:   ${agg.sessions_skipped}`);
  console.log(`  memories planned:   ${agg.memories_planned}`);
  console.log(`  memories inserted:  ${agg.memories_inserted}${dryRun ? ' (DRY RUN — nothing written)' : ''}`);
  console.log(`  file_edits inserted:${agg.file_edits_inserted}${dryRun ? ' (DRY RUN)' : ''}`);
  console.log(`  memory files:       ${agg.memory_files_imported}${dryRun ? ' (DRY RUN)' : ''}`);
  console.log(`  errors:             ${agg.errors}`);

  if (!dryRun) await shutdownPrisma();
}

main().catch((e) => { console.error(e); process.exit(1); });
