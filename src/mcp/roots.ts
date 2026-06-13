// Roots block — track the client's working roots (directories the agent is operating in).
//
// The server pulls roots from the client via server.request({method: 'roots/list'}) and caches them.
// Used by recall_file and read_smart to bias path-substring matches toward files inside a current root.
//
// MCP semantics: client owns the root list, server is informed. We refresh on demand
// (lazily on first use) and on roots/list_changed notification.
//
// Fallback: when the MCP client does not declare the roots capability (e.g. older Claude Code
// versions that pre-date roots support), CHEST_ROOTS env var provides an explicit allow-list.
// Format: colon-separated absolute paths on POSIX, semicolon-separated on Windows — same
// convention as the PATH variable.

import { realpathSync } from 'node:fs';
import { resolve, delimiter } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

interface Root {
  uri: string; // typically "file:///abs/path"
  name?: string;
}

let cachedRoots: Root[] | null = null;
let lastFetched = 0;
const STALE_MS = 60_000; // re-fetch at most once a minute

// Test-only: clear the roots cache so a test can change the client's roots
// between cases. Not used by production code paths.
export function resetRootsCache(): void {
  cachedRoots = null;
  lastFetched = 0;
}

export async function fetchRoots(server: Server): Promise<Root[]> {
  const now = Date.now();
  if (cachedRoots && now - lastFetched < STALE_MS) return cachedRoots;

  // Try the MCP protocol first (client declares "roots" capability during handshake).
  try {
    const res = (await server.request(
      { method: 'roots/list', params: {} },
      ListRootsRequestSchema,
    )) as { roots?: Root[] };
    const roots = Array.isArray(res?.roots) ? res.roots : [];
    if (roots.length > 0) {
      cachedRoots = roots;
      lastFetched = now;
      return cachedRoots;
    }
    // Protocol succeeded but returned an empty list — fall through to env fallback.
  } catch {
    // Client does not support the roots capability (e.g. older Claude Code versions).
    // Fall through to the CHEST_ROOTS env fallback below.
  }

  // Fallback: CHEST_ROOTS — colon-separated (POSIX) or semicolon-separated (Windows) paths.
  // Enables chest_read_smart when the MCP client does not implement roots/list.
  // The REST backend never has CHEST_ROOTS set, so it continues to fail closed.
  const envRoots = process.env['CHEST_ROOTS'];
  if (envRoots) {
    cachedRoots = envRoots
      .split(delimiter)
      .filter(Boolean)
      .map((p) => ({ uri: pathToFileURL(p).toString() }));
  } else {
    cachedRoots = [];
  }
  lastFetched = now;
  return cachedRoots;
}

// Convert "file:///C:/Users/HP/foo" → "C:/Users/HP/foo" (or "/Users/foo" on POSIX)
export function rootPathFromUri(uri: string): string {
  if (uri.startsWith('file:///')) {
    let p = uri.slice('file:///'.length);
    // Windows: convert "C:/Users/..." (already POSIX-ish) — leave as-is, caller normalizes.
    if (process.platform === 'win32') {
      // also handle "C%3A/" encoding
      p = p.replace(/^([A-Za-z])(?:%3A|:)\//, '$1:/');
    } else {
      p = '/' + p;
    }
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  }
  return uri;
}

// Returns true if filePath is inside any of the roots (case-insensitive on win32).
//
// NOTE: empty roots → true (allow-all). This is a *recall biasing* helper and
// must NOT be used for security decisions. For file-read confinement use
// confinePath(), which fails CLOSED on empty roots.
export function isInsideRoots(filePath: string, roots: Root[]): boolean {
  if (roots.length === 0) return true; // no roots → no filtering
  const norm = process.platform === 'win32' ? filePath.toLowerCase().replace(/\\/g, '/') : filePath;
  return roots.some((r) => {
    const rp = rootPathFromUri(r.uri);
    const rpn = process.platform === 'win32' ? rp.toLowerCase().replace(/\\/g, '/') : rp;
    return norm.startsWith(rpn);
  });
}

// Security-grade path confinement for file reads (fails CLOSED).
//
// Resolves the requested path to an absolute, symlink-free canonical path and
// returns it ONLY if it lies inside at least one declared root. Returns null
// when the path escapes every root, when it cannot be canonicalized (e.g. does
// not exist), or when there are NO roots at all. The empty-roots case denying
// every read is what makes the REST backend (which has no MCP client and thus
// no roots) refuse chest_read_smart without any deployment conditional.
//
// Callers MUST use the returned canonical path for both stat and read so the
// security check and the actual read observe the same path (no TOCTOU gap).
export function confinePath(requestedPath: string, roots: Root[]): string | null {
  if (roots.length === 0) return null; // fail closed: no roots → nothing readable
  let canonical: string;
  try {
    canonical = realpathSync(resolve(requestedPath));
  } catch {
    return null; // unresolvable (missing / broken symlink) → deny
  }
  return isInsideRoots(canonical, roots) ? canonical : null;
}
