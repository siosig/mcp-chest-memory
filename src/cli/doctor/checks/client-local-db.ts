// Client-side local SQLite database check (CHEST_MODE=local only).
//
// FR-023 (local branch): when running against an on-disk SQLite database,
// confirm the file exists, is non-empty, and the containing directory is
// writable so that the agent can persist new memories.

import { access, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname } from "node:path";
import type { CheckResult } from "../types.js";
import { dbPath, validateEnv } from "../../../utils/env.js";

type PartialResult = Omit<CheckResult, "id" | "title" | "category" | "duration_ms">;

export async function checkLocalDb(): Promise<PartialResult> {
  const env = validateEnv();
  if (env.CHEST_MODE !== "local") {
    return {
      status: "skip",
      message: "CHEST_MODE is not 'local'; local DB check skipped",
      fix_hint: "",
    };
  }
  const path = dbPath(env);
  let st: Awaited<ReturnType<typeof stat>>;
  try {
    st = await stat(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {
        status: "fail",
        message: `Local DB file does not exist at ${path}`,
        fix_hint: "Initialize the database: run `chest-index init` or the equivalent migration command.",
      };
    }
    return {
      status: "fail",
      message: `Failed to stat ${path}: ${(err as Error).message}`,
      fix_hint: "Check filesystem permissions on the DB directory.",
    };
  }
  if (!st.isFile()) {
    return {
      status: "fail",
      message: `Path ${path} exists but is not a regular file`,
      fix_hint: "Remove the conflicting entry and reinitialize the database.",
    };
  }
  if (st.size === 0) {
    return {
      status: "fail",
      message: `Local DB at ${path} is empty (size=0)`,
      fix_hint: "Recreate the database: run `chest-index init` or restore from backup.",
    };
  }
  const parent = dirname(path);
  try {
    await access(parent, fsConstants.W_OK);
  } catch {
    return {
      status: "fail",
      message: `DB directory ${parent} is not writable by this process`,
      fix_hint: `Fix permissions: chmod u+w ${parent}`,
    };
  }
  return {
    status: "ok",
    message: `Local DB present and writable at ${path} (size=${st.size})`,
    fix_hint: "",
  };
}
