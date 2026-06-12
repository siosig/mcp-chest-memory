// DB import for curated auto-memory markdown files (<projectDir>/memory/*.md).
// Lives in lib (not bin/) so the logic is unit-testable: importing the bin
// entrypoint would execute its main() side effect.

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { prisma, rawGet, rawRun, lastInsertId } from './db/prisma-client.js';
import { collectMemoryFiles, parseMemoryMarkdown, mapMemoryType, buildMemoryContent, type ParsedMemoryFile } from './memory-md.js';
import { MAX_CONTENT_CHARS } from './embedding/config.js';
import { normalizeEntityName } from './normalize.js';
import { redactText } from './redact.js';

export async function resolveProjectEntity(projectName: string): Promise<number> {
  const canonicalKey = `project:${projectName.toLowerCase()}`;
  const normalized = normalizeEntityName(projectName);
  const existing = await rawGet<{ id: number }>(
    prisma,
    'SELECT id FROM entities WHERE canonical_key = ? OR (kind = ? AND normalized_name = ?) OR (kind = ? AND LOWER(name) = LOWER(?))',
    canonicalKey, 'project', normalized, 'project', projectName,
  );
  if (existing) {
    await rawRun(prisma, 'UPDATE entities SET normalized_name = ? WHERE id = ? AND normalized_name IS NULL', normalized, existing.id);
    return existing.id;
  }
  await rawRun(prisma, 'INSERT INTO entities (kind, name, normalized_name, canonical_key) VALUES (?, ?, ?, ?)', 'project', projectName, normalized, canonicalKey);
  return lastInsertId(prisma);
}

// Idempotent wipe scoped to one memory-dir import: every row written by
// importMemoryDir carries the pseudo session id in source/payload.
async function wipeMemoryImport(pseudoSessionId: string): Promise<void> {
  const needle = `%"session_id":"${pseudoSessionId}"%`;
  await rawRun(prisma, 'DELETE FROM memories WHERE source LIKE ?', needle);
  await rawRun(prisma, 'DELETE FROM events WHERE payload LIKE ?', needle);
}

// Import curated auto-memory markdown files for one project dir.
// Idempotent via wipe & re-insert keyed on `memory-md:<dirName>`.
export async function importMemoryDir(
  projectDir: string,
  projectName: string,
  dryRun: boolean,
): Promise<{ files: number; memories: number }> {
  const files = collectMemoryFiles(projectDir);
  if (files.length === 0) return { files: 0, memories: 0 };

  const pseudoSessionId = `memory-md:${basename(projectDir)}`;
  const parsedFiles: { file: string; parsed: ParsedMemoryFile }[] = [];
  for (const f of files) {
    let raw: string;
    try { raw = readFileSync(f, 'utf8'); } catch { continue; }
    const parsed = parseMemoryMarkdown(raw, basename(f));
    if (parsed) parsedFiles.push({ file: basename(f), parsed });
  }
  if (parsedFiles.length === 0) return { files: 0, memories: 0 };

  if (dryRun) {
    console.log(`  [dry] memory files (${projectName}): ${parsedFiles.length} importable`);
    return { files: parsedFiles.length, memories: parsedFiles.length };
  }

  await wipeMemoryImport(pseudoSessionId);
  const projectEntityId = await resolveProjectEntity(projectName);

  let memories = 0;
  await prisma.$transaction(
    async (tx) => {
      for (const { file, parsed } of parsedFiles) {
        const mapping = mapMemoryType(parsed.type);
        const source = {
          session_id: pseudoSessionId,
          kind: 'memory_file',
          file,
          ...(parsed.type ? { type: parsed.type } : {}),
          ...(parsed.originSessionId ? { origin_session_id: parsed.originSessionId } : {}),
        };
        await rawRun(
          tx,
          'INSERT INTO memories (entity_id, layer, content, importance, source) VALUES (?, ?, ?, ?, ?)',
          projectEntityId, mapping.layer, redactText(buildMemoryContent(parsed, MAX_CONTENT_CHARS)), mapping.importance, JSON.stringify(source),
        );
        memories++;
      }
      await rawRun(
        tx,
        'INSERT INTO events (entity_id, kind, payload) VALUES (?, ?, ?)',
        projectEntityId, 'memory_files_imported',
        JSON.stringify({ session_id: pseudoSessionId, files: parsedFiles.length }),
      );
    },
    { timeout: 120_000, maxWait: 30_000 },
  );
  return { files: parsedFiles.length, memories };
}
