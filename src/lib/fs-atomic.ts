// Atomic file write: write to a temp file in the same directory, fsync, then
// rename into place. On POSIX the rename is atomic, so an interrupted write can
// never leave the target truncated or empty — the previous content survives
// until the rename succeeds. Default mode 0600 keeps secret-bearing files
// (settings, tokens) owner-only.

import { mkdirSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, basename } from "node:path";

export function writeFileAtomic(
  filePath: string,
  data: string,
  mode: number = 0o600,
): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.${basename(filePath)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, data, { mode });
    // Flush the temp file's contents to disk before the rename so a crash right
    // after rename cannot leave an empty file with the target name.
    const fd = openSync(tmp, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, filePath);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* temp already gone */
    }
    throw err;
  }
}
