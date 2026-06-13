#!/usr/bin/env node
// Stop-hook entrypoint for Claude Code.
//
// Claude Code invokes this script when an assistant turn finishes (Stop event).
// It receives JSON on stdin like: { session_id, transcript_path, cwd, ... }
// We use transcript_path (the active jsonl) and feed it to the importer.
//
// CONTRACT:
//   - MUST exit 0 on success OR failure — never block Claude Code
//   - MUST be silent on stdout (Claude does not need feedback)
//   - All errors logged to ~/.chest-memory/hook.log

import { spawnSync } from 'node:child_process';
import { mkdirSync, appendFileSync, existsSync, statSync, renameSync, readFileSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { isPathInside } from '../lib/path-guard.js';
import { fileURLToPath } from 'node:url';
import { chestRootDir, validateEnv } from '../utils/env.js';

const LOG_DIR = chestRootDir(validateEnv());
const LOG_FILE = join(LOG_DIR, 'hook.log');
const LOG_MAX_BYTES = 1024 * 1024; // 1 MB → rotate

function log(msg: string): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
    // Rotate if too big
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > LOG_MAX_BYTES) {
      try { renameSync(LOG_FILE, LOG_FILE + '.1'); } catch { /* ignore */ }
    }
    // Owner-only: the log records session ids / cwd / transcript paths.
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`, { mode: 0o600 });
  } catch { /* never throw from log */ }
}

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    // If no stdin within 500ms (e.g. invoked manually), give up — Stop hook always provides JSON
    setTimeout(() => resolve(data), 500);
  });
}

interface StopHookPayload {
  transcript_path?: string;
  session_id?: string;
  cwd?: string;
  stop_hook_active?: boolean;
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  let payload: StopHookPayload = {};
  try {
    const raw = await readStdin();
    if (raw.trim()) payload = JSON.parse(raw) as StopHookPayload;
  } catch (e: unknown) {
    log(`stdin parse error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(0);
  }

  const transcriptPath = payload.transcript_path;
  const sessionId = payload.session_id;
  const cwd = payload.cwd;
  const stopHookActive = !!payload.stop_hook_active;

  if (!transcriptPath) {
    log(`no transcript_path in payload (session=${sessionId ?? '?'}, keys=${Object.keys(payload).join(',')})`);
    process.exit(0);
  }
  if (stopHookActive) {
    // We're in a recursive Stop chain — do nothing
    log(`stop_hook_active=true, skipping (session=${sessionId})`);
    process.exit(0);
  }

  // Find the importer script — it lives next to us in dist/bin/
  const __filename = fileURLToPath(import.meta.url);
  const importerPath = join(dirname(__filename), 'import-sessions.js');

  // Security: only import transcripts under ~/.claude/projects. The payload
  // arrives on stdin; an attacker who can inject the Stop-hook stream must not be
  // able to point the importer at arbitrary files on disk.
  const projectsRoot = join(homedir(), '.claude', 'projects');
  let resolvedTranscript: string;
  try {
    resolvedTranscript = realpathSync(transcriptPath);
  } catch {
    log(`transcript unresolvable: ${transcriptPath}`);
    process.exit(0);
  }
  if (!isPathInside(resolvedTranscript, projectsRoot)) {
    log(`transcript_path outside ~/.claude/projects, refusing: ${resolvedTranscript}`);
    process.exit(0);
  }

  if (!existsSync(resolvedTranscript)) {
    log(`transcript missing: ${transcriptPath}`);
    process.exit(0);
  }

  // Remote mode: POST the JSONL content to the remote backend for server-side import.
  if ((process.env['CHEST_MODE'] ?? 'local') === 'remote') {
    try {
      const content = readFileSync(resolvedTranscript, 'utf8');
      const { syncSessionRemote } = await import('../lib/hooks-remote.js');
      await syncSessionRemote(content, sessionId ?? '');
      const elapsed = Date.now() - startedAt;
      log(`remote sync ok (session=${sessionId}, cwd=${cwd}, ${elapsed}ms)`);
    } catch (e: unknown) {
      const elapsed = Date.now() - startedAt;
      log(`remote sync error (session=${sessionId}, ${elapsed}ms): ${e instanceof Error ? e.message : String(e)}`);
    }
    process.exit(0);
  }

  const r = spawnSync(process.execPath, [importerPath, '--session-file', resolvedTranscript], {
    encoding: 'utf8',
    timeout: 30000,
  });

  const elapsed = Date.now() - startedAt;
  if (r.error) {
    log(`importer spawn error (session=${sessionId}, ${elapsed}ms): ${r.error.message}`);
    process.exit(0);
  } else if (r.status !== 0) {
    log(`importer exited ${r.status} (session=${sessionId}, ${elapsed}ms): ${(r.stderr || '').slice(0, 500)}`);
    process.exit(0);
  }

  const out = (r.stdout || '').trim().split('\n').slice(-1)[0] || '';
  log(`ok (session=${sessionId}, cwd=${cwd}, ${elapsed}ms): ${out}`);

  process.exit(0);
}

main().catch((e) => {
  log(`unhandled: ${e?.message ?? e}`);
  process.exit(0);
});
