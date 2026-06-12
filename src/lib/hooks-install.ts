// Wiring of the Claude Code hooks into ~/.claude/settings.json.
//
// Three hooks ship with chest-memory:
//   Stop         → chest-memory-sync           (auto-capture the session)
//   PreCompact   → chest-memory-precompact     (save a work-state snapshot)
//   SessionStart → chest-memory-session-start  (restore the snapshot)
//
// Shared by chest-memory-install-hooks and chest-memory-setup; both wire absolute
// `node <dist/bin/script>.js` commands. All operations are idempotent: an
// entry is matched by its marker (the hook script name), added when missing,
// rewritten when the command changed (e.g. a new --data-dir, or a legacy
// `npx -y chest-memory-*` entry from an older setup), and left alone when
// identical.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type HookEvent = 'Stop' | 'PreCompact' | 'SessionStart';

export interface HookSpec {
  event: HookEvent;
  /** Full shell command Claude Code should run. */
  command: string;
  /** Substrings identifying an existing entry as ours (script/bin names). */
  markers: string[];
}

export type HookAction = 'added' | 'updated' | 'unchanged' | 'removed';

export interface HookResult {
  event: HookEvent;
  action: HookAction;
}

interface HookEntry {
  matcher?: string;
  hooks?: Array<{ type?: string; command?: string }>;
}

interface SettingsJson {
  hooks?: Partial<Record<string, HookEntry[]>>;
  [key: string]: unknown;
}

// The script name is the marker for current commands; the bin name still
// matches (and thereby migrates or removes) legacy `npx -y chest-memory-*`
// entries written by older setups.
const HOOK_BINS: Record<HookEvent, { script: string; npxBin: string }> = {
  Stop: { script: 'sync-session.js', npxBin: 'chest-memory-sync' },
  PreCompact: { script: 'precompact.js', npxBin: 'chest-memory-precompact' },
  SessionStart: { script: 'session-start.js', npxBin: 'chest-memory-session-start' },
};

export const HOOK_EVENTS = Object.keys(HOOK_BINS) as HookEvent[];

function markersFor(event: HookEvent): string[] {
  const { script, npxBin } = HOOK_BINS[event];
  return [script, npxBin];
}

/** Hook specs for a git-clone install: absolute node commands against dist/. */
export function buildNodeHookSpecs(opts: {
  distBinDir: string;
  dataDir?: string;
  dbPath?: string;
}): HookSpec[] {
  // Hooks run with Claude Code's environment, not the installer's, so the
  // chosen data location must be embedded into the command itself.
  const env = [
    opts.dataDir ? `CHEST_DATA_DIR=${shellQuote(opts.dataDir)}` : '',
    opts.dbPath ? `CHEST_DB_PATH=${shellQuote(opts.dbPath)}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  const prefix = env ? `${env} ` : '';
  return HOOK_EVENTS.map((event) => ({
    event,
    command: `${prefix}node ${shellQuote(join(opts.distBinDir, HOOK_BINS[event].script))}`,
    markers: markersFor(event),
  }));
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_\-./~]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

function loadSettings(settingsPath: string): SettingsJson {
  if (!existsSync(settingsPath)) return {};
  const raw = readFileSync(settingsPath, 'utf8');
  if (raw.trim() === '') return {};
  // A corrupt settings.json must abort: silently replacing it would destroy
  // the user's permissions, env, and unrelated hooks.
  return JSON.parse(raw) as SettingsJson;
}

function saveSettings(settingsPath: string, settings: SettingsJson): void {
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
}

function findEntry(
  entries: HookEntry[],
  markers: string[],
): { entry: HookEntry; hook: { type?: string; command?: string } } | null {
  for (const entry of entries) {
    for (const hook of entry.hooks ?? []) {
      if (markers.some((m) => hook.command?.includes(m))) return { entry, hook };
    }
  }
  return null;
}

/**
 * Ensure every spec is present in settings.json. Returns one result per spec.
 * Throws when settings.json exists but cannot be parsed.
 */
export function wireHooks(settingsPath: string, specs: HookSpec[]): HookResult[] {
  const settings = loadSettings(settingsPath);
  const results: HookResult[] = [];
  let dirty = false;

  for (const spec of specs) {
    if (!settings.hooks) settings.hooks = {};
    const entries = (settings.hooks[spec.event] ??= []);
    const found = findEntry(entries, spec.markers);
    if (found) {
      if (found.hook.command === spec.command) {
        results.push({ event: spec.event, action: 'unchanged' });
      } else {
        found.hook.command = spec.command;
        found.hook.type = 'command';
        results.push({ event: spec.event, action: 'updated' });
        dirty = true;
      }
    } else {
      entries.push({ matcher: '', hooks: [{ type: 'command', command: spec.command }] });
      results.push({ event: spec.event, action: 'added' });
      dirty = true;
    }
  }

  if (dirty) saveSettings(settingsPath, settings);
  return results;
}

/**
 * Remove every chest-memory hook entry. Returns one result per event that had
 * an entry. Missing or empty settings.json is a no-op.
 */
export function removeHooks(settingsPath: string): HookResult[] {
  let settings: SettingsJson;
  try {
    settings = loadSettings(settingsPath);
  } catch {
    return []; // corrupt settings: leave it to the user, nothing to remove safely
  }
  if (!settings.hooks) return [];

  const results: HookResult[] = [];
  let dirty = false;
  for (const event of HOOK_EVENTS) {
    const entries = settings.hooks[event];
    if (!entries) continue;
    const markers = markersFor(event);
    const kept = entries.filter(
      (entry) => !entry.hooks?.some((h) => markers.some((m) => h.command?.includes(m))),
    );
    if (kept.length !== entries.length) {
      if (kept.length > 0) settings.hooks[event] = kept;
      else delete settings.hooks[event];
      results.push({ event, action: 'removed' });
      dirty = true;
    }
  }
  if (dirty) saveSettings(settingsPath, settings);
  return results;
}
