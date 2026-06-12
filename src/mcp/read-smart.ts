// read_smart handler: the flagship token-saving feature.
// Returns full content on first read, "unchanged" metadata on re-read (~50 tokens),
// or only the changed chunks + unchanged summary on real modifications.

import { readFileSync, statSync } from 'node:fs';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { chunkFile, hashFile, type Chunk } from '../lib/file-chunker.js';
import { instantFromUnixSeconds } from '../utils/temporal.js';
import { estimateTokens, TOKENS_PER_CHAR } from '../lib/token-budget.js';
import { confinePath, fetchRoots } from './roots.js';
import type { SnapshotStore } from './snapshot-store.js';

interface StoredChunkMeta {
  id: string;
  kind: string;
  start_line: number;
  end_line: number;
  hash: string;
}

function toMeta(c: Chunk): StoredChunkMeta {
  return { id: c.id, kind: c.kind, start_line: c.start_line, end_line: c.end_line, hash: c.hash };
}

export async function handleReadSmart(
  args: { path: string; force?: boolean },
  server: Server,
  store: SnapshotStore,
): Promise<string> {
  const { path: requestedPath, force = false } = args;

  // Security: confine the read to the MCP client's declared roots, resolving
  // symlinks. Fails closed when no roots exist (e.g. the REST backend, which has
  // no client) so a token holder cannot read arbitrary host files. The returned
  // canonical path is used for BOTH stat and read — no second resolution, so the
  // check and the read observe the same path (no TOCTOU window).
  const roots = await fetchRoots(server);
  const path = confinePath(requestedPath, roots);
  if (path === null) {
    return JSON.stringify({
      ok: false,
      error: `Access denied: path is outside the allowed roots (or no roots are declared): ${requestedPath}`,
    });
  }

  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch {
    return JSON.stringify({ ok: false, error: `File not found: ${requestedPath}` });
  }

  const mtime = Math.floor(stat.mtimeMs / 1000);
  const size = stat.size;

  const { snapshot: prior, facts } = await store.get(path);

  // --- CASE A: first read or force ---
  if (!prior || force) {
    const content = readFileSync(path, 'utf8');
    const fileHash = hashFile(content);
    const chunks = chunkFile(path, content);
    const chunkMeta = chunks.map(toMeta);

    await store.put({
      path,
      content_hash: fileHash,
      mtime,
      size_bytes: size,
      chunks: JSON.stringify(chunkMeta),
    });

    return JSON.stringify({
      ok: true,
      status: force ? 'forced_full' : 'first_read',
      path,
      content,
      chunks: chunkMeta,
      bytes: size,
      tokens_approx: estimateTokens(content),
      tokens_saved: 0,
    });
  }

  // --- CASE B: mtime unchanged → content guaranteed unchanged (fast path) ---
  if (prior.mtime === mtime) {
    await store.touch(path);

    const storedChunks = JSON.parse(prior.chunks) as StoredChunkMeta[];

    // Token savings = what a full read would have cost
    const savedTokens = Math.round(size * TOKENS_PER_CHAR);

    return JSON.stringify({
      ok: true,
      status: 'unchanged',
      path,
      last_read_at: instantFromUnixSeconds(prior.last_read_at),
      chunk_count: storedChunks.length,
      chunks: storedChunks,
      file_facts: facts,
      tokens_saved: savedTokens,
      note: 'File unchanged since last read. Call with force:true if full content is needed.',
    });
  }

  // --- CASE C: mtime changed → compute hash, maybe false alarm ---
  const content = readFileSync(path, 'utf8');
  const fileHash = hashFile(content);

  if (fileHash === prior.content_hash) {
    await store.touch(path, mtime);
    return JSON.stringify({
      ok: true,
      status: 'unchanged_content',
      path,
      note: 'mtime changed but sha256 identical (file was touched but not modified).',
      tokens_saved: Math.round(size * TOKENS_PER_CHAR),
    });
  }

  // --- CASE D: real diff ---
  const newChunks = chunkFile(path, content);
  const oldChunks = JSON.parse(prior.chunks) as StoredChunkMeta[];
  const oldById = new Map(oldChunks.map((c) => [c.id, c]));

  const changedChunks: Array<{ id: string; kind: string; status: 'added' | 'modified'; start_line: number; end_line: number; content: string }> = [];
  const unchangedChunks: StoredChunkMeta[] = [];
  const seenIds = new Set<string>();

  for (const c of newChunks) {
    seenIds.add(c.id);
    const prev = oldById.get(c.id);
    if (!prev) {
      changedChunks.push({ id: c.id, kind: c.kind, status: 'added', start_line: c.start_line, end_line: c.end_line, content: c.content });
    } else if (prev.hash !== c.hash) {
      changedChunks.push({ id: c.id, kind: c.kind, status: 'modified', start_line: c.start_line, end_line: c.end_line, content: c.content });
    } else {
      unchangedChunks.push({ id: c.id, kind: c.kind, start_line: c.start_line, end_line: c.end_line, hash: c.hash });
    }
  }

  const removedChunks = oldChunks
    .filter((c) => !seenIds.has(c.id))
    .map((c) => ({ id: c.id, kind: c.kind, prev_lines: `${c.start_line}-${c.end_line}` }));

  const newChunkMeta = newChunks.map(toMeta);
  await store.put({
    path,
    content_hash: fileHash,
    mtime,
    size_bytes: size,
    chunks: JSON.stringify(newChunkMeta),
  });

  const fullTokens = estimateTokens(content);
  const returnedTokens = changedChunks.reduce((s, c) => s + estimateTokens(c.content), 0) + 80; // ~80 for the envelope
  const savedTokens = Math.max(0, fullTokens - returnedTokens);
  const pctSaved = fullTokens > 0 ? Math.round((savedTokens / fullTokens) * 100) : 0;

  return JSON.stringify({
    ok: true,
    status: 'modified',
    path,
    changed_chunks: changedChunks,
    unchanged_chunks: unchangedChunks,
    removed_chunks: removedChunks,
    summary: {
      changed: changedChunks.length,
      unchanged: unchangedChunks.length,
      removed: removedChunks.length,
      tokens_full: fullTokens,
      tokens_returned: returnedTokens,
      tokens_saved: savedTokens,
      pct_saved: pctSaved,
    },
  });
}
