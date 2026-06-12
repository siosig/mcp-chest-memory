#!/usr/bin/env node
// Claude Code PreCompact hook entry point.
// stdin: { session_id, transcript_path, trigger: "manual"|"auto" }
// Saves a working-state snapshot (≤2 KB) for the given session to session_snapshots (UPSERT).
//
// Fail-silent: exits 0 on any error so compaction is never blocked.
// Logs are appended to ~/.chest-memory/hook.log (same file as sync-session).

import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const LOG_DIR = process.env.CHEST_DATA_DIR ?? join(homedir(), '.chest-memory');
const LOG_FILE = join(LOG_DIR, 'hook.log');

function log(msg: string): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [precompact] ${msg}\n`, { mode: 0o600 });
  } catch {
    /* logging must never throw */
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

interface PreCompactPayload {
  session_id?: string;
  transcript_path?: string;
  trigger?: string;
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  let payload: PreCompactPayload = {};
  try {
    const raw = await readStdin();
    if (raw.trim()) payload = JSON.parse(raw) as PreCompactPayload;
  } catch (e: unknown) {
    log(`stdin parse error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(0);
  }

  const sessionId = payload.session_id;
  if (!sessionId) {
    log(`no session_id in payload (keys=${Object.keys(payload).join(',')})`);
    process.exit(0);
  }

  try {
    // DB imports are deferred until after payload validation so a missing DATABASE_URL
    // logs gracefully instead of crashing immediately.
    const { saveSnapshot } = await import('../lib/snapshot/store.js');
    const { shutdownPrisma } = await import('../lib/db/prisma-client.js');
    const text = await saveSnapshot(sessionId);
    await shutdownPrisma();
    const elapsed = Date.now() - startedAt;
    if (text === '') {
      log(`no session data, snapshot skipped (session=${sessionId}, ${elapsed}ms)`);
    } else {
      log(`snapshot saved (session=${sessionId}, trigger=${payload.trigger ?? '?'}, ${Buffer.byteLength(text, 'utf8')}B, ${elapsed}ms)`);
    }
  } catch (e: unknown) {
    log(`snapshot failed (session=${sessionId}): ${e instanceof Error ? e.message : String(e)}`);
  }
  process.exit(0);
}

main().catch((e) => {
  log(`unhandled: ${e?.message ?? e}`);
  process.exit(0);
});
