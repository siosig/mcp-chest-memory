#!/usr/bin/env node
// Claude Code SessionStart hook entry point.
// stdin: { session_id, source: "startup"|"resume"|"clear"|"compact" }
// Outputs a previously saved snapshot as <session_knowledge> on stdout (injected as
// additionalContext by Claude Code) only when source is "compact" or "resume".
//
// Fail-silent: exits 0 with empty stdout on any error so session start is never blocked.

import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const LOG_DIR = process.env.CHEST_DATA_DIR ?? join(homedir(), '.chest-memory');
const LOG_FILE = join(LOG_DIR, 'hook.log');

function log(msg: string): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [session-start] ${msg}\n`);
  } catch {
    /* logging must never throw */
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

interface SessionStartPayload {
  session_id?: string;
  source?: string;
}

// Only inject into resumed or post-compact sessions; suppress for fresh startups and clears.
const INJECT_SOURCES = new Set(['compact', 'resume']);

async function main(): Promise<void> {
  const startedAt = Date.now();
  let payload: SessionStartPayload = {};
  try {
    const raw = await readStdin();
    if (raw.trim()) payload = JSON.parse(raw) as SessionStartPayload;
  } catch (e: unknown) {
    log(`stdin parse error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(0);
  }

  const sessionId = payload.session_id;
  const source = payload.source ?? '';
  if (!sessionId || !INJECT_SOURCES.has(source)) {
    process.exit(0); // Normal skip — no log to avoid per-startup noise.
  }

  try {
    const { loadSnapshot } = await import('../lib/snapshot/store.js');
    const { shutdownPrisma } = await import('../lib/db/prisma-client.js');
    const text = await loadSnapshot(sessionId);
    await shutdownPrisma();
    const elapsed = Date.now() - startedAt;
    if (text) {
      process.stdout.write(`<session_knowledge>\n${text}\n</session_knowledge>\n`);
      log(`snapshot injected (session=${sessionId}, source=${source}, ${Buffer.byteLength(text, 'utf8')}B, ${elapsed}ms)`);
    } else {
      log(`no snapshot found (session=${sessionId}, source=${source}, ${elapsed}ms)`);
    }
  } catch (e: unknown) {
    log(`inject failed (session=${sessionId}): ${e instanceof Error ? e.message : String(e)}`);
  }
  process.exit(0);
}

main().catch((e) => {
  log(`unhandled: ${e?.message ?? e}`);
  process.exit(0);
});
