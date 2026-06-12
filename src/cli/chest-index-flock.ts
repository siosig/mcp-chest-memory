// Single-instance lock for `chest-index` (FR-505, research.md D12).
//
// Node's `fs` does not expose flock(2), and shelling out to `flock` is Linux-only.
// For cross-platform (Linux/macOS/Windows) single-instance guarantees we use an
// O_EXCL lock file holding the owner PID, with stale-lock recovery via PID liveness
// (`process.kill(pid, 0)`). This approximates flock(2)'s crash-safety: a lock left
// behind by a dead process is reclaimed on the next run.

import { openSync, closeSync, writeSync, readFileSync, unlinkSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The lock lives in the user-owned data directory, not a world-writable temp
// dir. A shared /tmp path let any local user pre-create the lock (e.g. with PID
// 1) and permanently deny maintenance. Mirrors the data-dir resolution used by
// the hooks so the lock sits next to the database it guards.
const DATA_DIR = process.env["CHEST_DATA_DIR"] ?? join(homedir(), ".chest-memory");
try {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
} catch {
  /* best-effort: acquireLock surfaces real errors */
}
export const LOCK_PATH = join(DATA_DIR, "chest-index.lock");

export interface LockHandle {
  release(): void;
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // signal 0 = liveness probe, does not kill
    return true;
  } catch (err) {
    // ESRCH = no such process (dead). EPERM = alive but not ours (treat as alive).
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Try to acquire the lock. Returns a handle on success, or `null` if another live
 * instance already holds it (caller should exit 0 / skip, FR-505).
 */
export function acquireLock(lockPath: string = LOCK_PATH): LockHandle | null {
  const tryCreate = (): number | null => {
    try {
      return openSync(lockPath, "wx"); // O_CREAT | O_EXCL — atomic create-or-fail
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return null;
      throw err;
    }
  };

  let fd = tryCreate();
  if (fd === null) {
    // Lock exists — is the owner still alive?
    let ownerPid = 0;
    try {
      ownerPid = Number(readFileSync(lockPath, "utf8").trim()) || 0;
    } catch {
      /* unreadable — treat as stale */
    }
    if (pidAlive(ownerPid)) return null; // another live instance — skip
    // Stale lock from a dead process: reclaim it.
    try {
      unlinkSync(lockPath);
    } catch {
      /* race: someone else may have reclaimed — fall through to retry */
    }
    fd = tryCreate();
    if (fd === null) return null; // lost the race to another instance
  }

  writeSync(fd, String(process.pid));
  closeSync(fd);

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    try {
      unlinkSync(lockPath);
    } catch {
      /* already gone */
    }
  };

  // Best-effort release on normal exit and signals (approximates flock auto-release).
  process.once("exit", release);
  process.once("SIGINT", () => {
    release();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    release();
    process.exit(143);
  });

  return { release };
}
