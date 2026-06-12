// HTTP client used by the hook scripts (sync-session, precompact, session-start)
// when CHEST_MODE=remote.  Uses the same CHEST_REMOTE_URL / CHEST_API_TOKEN env
// vars as the MCP remote client so no additional configuration is required.

function remoteBase(): string {
  const url = process.env['CHEST_REMOTE_URL'];
  if (!url) throw new Error('CHEST_REMOTE_URL is not set');
  return url.replace(/\/$/, '');
}

function authHeaders(): Record<string, string> {
  const token = process.env['CHEST_API_TOKEN'];
  if (!token) throw new Error('CHEST_API_TOKEN is not set');
  return { Authorization: `Bearer ${token}` };
}

/**
 * Forward the raw JSONL content of a session transcript to the remote server
 * for import into the remote DB.
 */
export async function syncSessionRemote(
  content: string,
  sessionId: string,
): Promise<void> {
  const url = `${remoteBase()}/api/hooks/sync-session`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...authHeaders(),
      'Content-Type': 'text/plain',
      'X-Session-Id': sessionId,
    },
    body: content,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`sync-session remote error ${res.status}: ${body.slice(0, 200)}`);
  }
}

/**
 * Ask the remote server to build and persist a session snapshot.
 * Returns true if a snapshot was saved, false if there was no session data yet.
 */
export async function precompactRemote(sessionId: string): Promise<boolean> {
  const url = `${remoteBase()}/api/hooks/precompact`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...authHeaders(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ session_id: sessionId }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`precompact remote error ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as { ok: boolean; saved?: boolean };
  return json.saved ?? false;
}

/**
 * Load a previously saved session snapshot from the remote server.
 * Returns the snapshot text or null if not found.
 */
export async function loadSnapshotRemote(sessionId: string): Promise<string | null> {
  const url = `${remoteBase()}/api/hooks/snapshot/${encodeURIComponent(sessionId)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: authHeaders(),
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`snapshot remote error ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as { ok: boolean; text?: string };
  return json.text ?? null;
}
