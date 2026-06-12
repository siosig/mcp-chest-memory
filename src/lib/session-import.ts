// Library function: import a single session from raw JSONL content into the DB.
// Used by the remote hook endpoint (POST /api/hooks/sync-session) so the server
// can process session files forwarded by the Stop hook without needing a local file.

import { prisma, rawRun, lastInsertId } from './db/prisma-client.js';
import { parseSessionContent, detectProjectName } from './session-parser.js';
import { extractSession } from './session-extractor.js';
import { resolveProjectEntity } from './memory-md-import.js';
import { redactText } from './redact.js';
import type { ParsedSession } from './session-parser.js';
import type { ExtractionResult } from './session-extractor.js';

export interface ImportSingleResult {
  sessionId: string;
  projectName: string;
  memoriesInserted: number;
  editsInserted: number;
}

async function wipeSession(sessionId: string): Promise<void> {
  const sidNeedle = `%"session_id":"${sessionId}"%`;
  await rawRun(prisma, 'DELETE FROM session_file_edits WHERE session_id = ?', sessionId);
  await rawRun(prisma, 'DELETE FROM memories WHERE source LIKE ?', sidNeedle);
  await rawRun(prisma, 'DELETE FROM events WHERE payload LIKE ?', sidNeedle);
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

/**
 * Parse and import a session from raw JSONL text.
 * Returns null if the content is empty or cannot be parsed.
 * Idempotent: wipes any prior data for the same session_id before inserting.
 */
export async function importSessionContent(
  content: string,
): Promise<ImportSingleResult | null> {
  const parsed = parseSessionContent(content);
  if (!parsed) return null;

  const projectName = detectProjectName(parsed) || 'unknown';
  const result = extractSession(parsed, projectName);

  await wipeSession(result.session_id);
  const projectEntityId = await resolveProjectEntity(projectName);
  const inserted = await insertSessionData(projectEntityId, result, parsed);

  return {
    sessionId: result.session_id,
    projectName,
    memoriesInserted: inserted.memories,
    editsInserted: inserted.edits,
  };
}
