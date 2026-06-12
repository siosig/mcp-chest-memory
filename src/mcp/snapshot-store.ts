// Snapshot persistence port for chest_read_smart.
//
// chest_read_smart is the only tool that touches the client filesystem, so its
// file I/O (stat/read/chunk/hash) always runs in the MCP server process — the
// only place the target file actually exists. The *persistence* of the diff
// cache (file_snapshots / file_facts) is the part that may live elsewhere, so
// it is factored out behind this port:
//
//   - local profile  -> LocalSnapshotStore  (in-process SQLite via Prisma)
//   - remote profile -> RemoteSnapshotStore  (forwards to the REST backend)
//
// This is what lets remote mode keep the token-saving read: the file is read
// client-side (where it exists, under the client's declared roots) while only
// the snapshot rows travel to the backend. The profile choice is made once at
// the composition root (server.ts), exactly like the executor — no deployment
// branch ever enters the read_smart logic itself.

import { prisma, rawAll, rawGet, rawRun } from "../lib/db/prisma-client.js";

/** A persisted file snapshot row (numeric columns already coerced by numify). */
export interface SnapshotRow {
  path: string;
  content_hash: string;
  mtime: number;
  size_bytes: number;
  /** JSON-encoded StoredChunkMeta[]. */
  chunks: string;
  last_read_at: number;
  read_count: number;
}

/** A row of file_facts (currently read-only; no producer ships yet). */
export interface FactRow {
  fact: string;
  layer: string | null;
  chunk_hash: string | null;
}

/** Fields needed to upsert a snapshot after a (first/forced/changed) read. */
export interface SnapshotUpsert {
  path: string;
  content_hash: string;
  mtime: number;
  size_bytes: number;
  /** JSON-encoded StoredChunkMeta[]. */
  chunks: string;
}

/**
 * Persistence of the read_smart diff cache. Implementations must keep the
 * read_count / last_read_at bookkeeping identical to the original in-process
 * SQL so token-savings reporting and recency are unaffected by the profile.
 */
export interface SnapshotStore {
  /** Prior snapshot for a path (or null) plus its facts (empty when no prior). */
  get(path: string): Promise<{ snapshot: SnapshotRow | null; facts: FactRow[] }>;
  /** Insert or replace a snapshot, bumping read_count. */
  put(input: SnapshotUpsert): Promise<void>;
  /** Bump read_count/last_read_at; optionally refresh mtime (touched-not-modified). */
  touch(path: string, mtime?: number): Promise<void>;
}

/** In-process SQLite implementation (local mode and the REST backend). */
export class LocalSnapshotStore implements SnapshotStore {
  async get(path: string): Promise<{ snapshot: SnapshotRow | null; facts: FactRow[] }> {
    const snapshot =
      (await rawGet<SnapshotRow>(prisma, "SELECT * FROM file_snapshots WHERE path = ?", path)) ??
      null;
    if (!snapshot) return { snapshot: null, facts: [] };
    const facts = await rawAll<FactRow>(
      prisma,
      "SELECT fact, layer, chunk_hash FROM file_facts WHERE file_path = ?",
      path,
    );
    return { snapshot, facts };
  }

  async put(input: SnapshotUpsert): Promise<void> {
    await rawRun(
      prisma,
      `INSERT INTO file_snapshots (path, content_hash, mtime, size_bytes, chunks, last_read_at, read_count)
       VALUES (?, ?, ?, ?, ?, unixepoch(), 1)
       ON CONFLICT(path) DO UPDATE SET
         content_hash = excluded.content_hash,
         mtime = excluded.mtime,
         size_bytes = excluded.size_bytes,
         chunks = excluded.chunks,
         last_read_at = unixepoch(),
         read_count = file_snapshots.read_count + 1`,
      input.path,
      input.content_hash,
      input.mtime,
      input.size_bytes,
      input.chunks,
    );
  }

  async touch(path: string, mtime?: number): Promise<void> {
    if (mtime === undefined) {
      await rawRun(
        prisma,
        "UPDATE file_snapshots SET last_read_at = unixepoch(), read_count = read_count + 1 WHERE path = ?",
        path,
      );
    } else {
      await rawRun(
        prisma,
        "UPDATE file_snapshots SET mtime = ?, last_read_at = unixepoch(), read_count = read_count + 1 WHERE path = ?",
        mtime,
        path,
      );
    }
  }
}
