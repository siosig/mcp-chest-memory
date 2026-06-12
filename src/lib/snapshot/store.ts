// Session snapshot persistence: collect source data, build, upsert, TTL cleanup, and load.

import { prisma, rawAll, rawGet, rawRun } from "../db/prisma-client.js";
import { buildSnapshot, type SnapshotInput, type SnapshotMemoryItem } from "./build.js";

/** Snapshots older than this many days are deleted when a new snapshot is saved. */
export const SNAPSHOT_TTL_DAYS = 14;

interface FileEditRow {
  file_path: string;
  op_count: number;
}

interface MemoryRow {
  content: string;
  importance: number;
}

/** Fetch memories from this session filtered by layer (matched via session_id in the source JSON). */
async function sessionMemories(sessionId: string, layer: string, limit: number): Promise<SnapshotMemoryItem[]> {
  const rows = await rawAll<MemoryRow>(
    prisma,
    `SELECT content, importance FROM memories
     WHERE layer = ? AND archived_at IS NULL AND source LIKE ?
     ORDER BY importance DESC, id DESC
     LIMIT ${Number(limit)}`,
    layer,
    `%"session_id":"${sessionId}"%`,
  );
  return rows.map((r) => ({ content: r.content, importance: Number(r.importance) }));
}

/** Collect snapshot source data from the database. */
export async function collectSnapshotInput(sessionId: string): Promise<SnapshotInput> {
  const fileEdits = await rawAll<FileEditRow>(
    prisma,
    `SELECT file_path, COUNT(*) AS op_count FROM session_file_edits
     WHERE session_id = ?
     GROUP BY file_path
     ORDER BY op_count DESC, MAX(occurred_at) DESC
     LIMIT 20`,
    sessionId,
  );
  const [realizes, goals, learnings] = await Promise.all([
    sessionMemories(sessionId, "realize", 10),
    sessionMemories(sessionId, "goal", 10),
    sessionMemories(sessionId, "learning", 10),
  ]);
  return {
    sessionId,
    fileEdits: fileEdits.map((f) => ({ filePath: f.file_path, opCount: Number(f.op_count) })),
    realizes,
    goals,
    learnings,
  };
}

/**
 * Build and persist the snapshot for a session. Does nothing if source data is empty.
 * The same session_id is UPSERTed; expired snapshots are pruned atomically on save.
 * @returns The saved snapshot text, or "" if nothing was saved.
 */
export async function saveSnapshot(sessionId: string, now: number = Math.floor(Date.now() / 1000)): Promise<string> {
  const input = await collectSnapshotInput(sessionId);
  const text = buildSnapshot(input);
  if (text === "") return "";

  await rawRun(
    prisma,
    `INSERT INTO session_snapshots (session_id, snapshot_text, created_at)
     VALUES (?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET snapshot_text = excluded.snapshot_text, created_at = excluded.created_at`,
    sessionId,
    text,
    now,
  );
  await rawRun(
    prisma,
    "DELETE FROM session_snapshots WHERE created_at < ?",
    now - SNAPSHOT_TTL_DAYS * 86400,
  );
  return text;
}

/**
 * Load the snapshot for a session (exact session_id match, within TTL).
 * No fallback to the most-recent snapshot: this database is shared across projects
 * and machines, so the risk of injecting another project's working state outweighs
 * the cost of a miss. Context compaction preserves session_id, so an exact match
 * is always sufficient for the primary use case.
 */
export async function loadSnapshot(
  sessionId: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<string | null> {
  const ttlFloor = now - SNAPSHOT_TTL_DAYS * 86400;
  const exact = await rawGet<{ snapshot_text: string }>(
    prisma,
    "SELECT snapshot_text FROM session_snapshots WHERE session_id = ? AND created_at >= ?",
    sessionId,
    ttlFloor,
  );
  return exact?.snapshot_text ?? null;
}
