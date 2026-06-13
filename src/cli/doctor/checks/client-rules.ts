// Client-side rules file checks.
//
// FR-021: verify the rules file is installed under `~/.claude/rules/` and is
// not older than the bundled distribution copy (`dist/rules/...` in the
// installed package, or `deploy/mcp-chest-memory.md` in the source tree).
//
// The canonical filename is `mcp-chest-memory.md` as written by
// `src/bin/setup.ts`. A legacy filename `chest-memory.md` is also accepted
// for installs that predate the rename, to avoid false "missing" warnings.

import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CheckResult } from "../types.js";

type PartialResult = Omit<CheckResult, "id" | "title" | "category" | "duration_ms">;

const FIX_HINT = "Run: npx chest-memory-setup";

export interface RulesCheckOpts {
  /** Override for tests — defaults to `os.homedir()`. */
  home?: string;
  /** Override for tests — explicit path to the bundled source rules file. */
  sourcePath?: string;
}

const PRIMARY_NAME = "mcp-chest-memory.md";
const LEGACY_NAME = "chest-memory.md";

function rulesDir(home: string): string {
  return join(home, ".claude", "rules");
}

async function statSafe(path: string): Promise<{ mtimeMs: number; size: number } | null> {
  try {
    const s = await stat(path);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
}

/**
 * Resolve the bundled source rules file. In an installed package this is
 * `dist/rules/mcp-chest-memory.md` next to the compiled doctor module; in the
 * source tree it lives at `<repo>/deploy/mcp-chest-memory.md`. We probe both.
 */
async function resolveSourceRules(): Promise<string | null> {
  const candidates: string[] = [];
  // Same package — alongside the compiled output.
  try {
    const here = fileURLToPath(new URL(".", import.meta.url));
    candidates.push(join(here, "..", "..", "..", "rules", PRIMARY_NAME));
  } catch {
    // ignore
  }
  // Source-tree fallback (running from `src/` via tsx).
  candidates.push(join(process.cwd(), "deploy", PRIMARY_NAME));
  for (const c of candidates) {
    const s = await statSafe(c);
    if (s) return c;
  }
  return null;
}

/** Locate the installed rules file under `~/.claude/rules/`. */
async function findInstalledRules(home: string): Promise<{ path: string; mtimeMs: number } | null> {
  for (const name of [PRIMARY_NAME, LEGACY_NAME]) {
    const path = join(rulesDir(home), name);
    const s = await statSafe(path);
    if (s && s.size > 0) return { path, mtimeMs: s.mtimeMs };
  }
  return null;
}

/** FR-021: the rules file MUST exist somewhere under `~/.claude/rules/`. */
export async function checkRulesExists(opts: RulesCheckOpts = {}): Promise<PartialResult> {
  const home = opts.home ?? homedir();
  const found = await findInstalledRules(home);
  if (!found) {
    return {
      status: "fail",
      message: `Rules file not found at ${join(rulesDir(home), PRIMARY_NAME)}`,
      fix_hint: FIX_HINT,
    };
  }
  return {
    status: "ok",
    message: `Rules installed at ${found.path}`,
    fix_hint: "",
  };
}

/** FR-021: warn when the installed rules file is older than the bundled copy. */
export async function checkRulesFresh(opts: RulesCheckOpts = {}): Promise<PartialResult> {
  const home = opts.home ?? homedir();
  const found = await findInstalledRules(home);
  if (!found) {
    return {
      status: "skip",
      message: "Rules file not installed; freshness check skipped",
      fix_hint: "",
    };
  }
  const sourcePath = opts.sourcePath ?? (await resolveSourceRules());
  if (!sourcePath) {
    return {
      status: "skip",
      message: "Bundled source rules file not locatable; freshness check skipped",
      fix_hint: "",
    };
  }
  const srcStat = await statSafe(sourcePath);
  if (!srcStat) {
    return {
      status: "skip",
      message: `Bundled source rules file not readable at ${sourcePath}`,
      fix_hint: "",
    };
  }
  // Reference `readFile` so the import isn't tree-shaken when unused; we may
  // expand to a content-hash comparison in a follow-up but date is the spec.
  void readFile;
  void dirname;
  if (found.mtimeMs + 1000 < srcStat.mtimeMs) {
    const installedDate = new Date(found.mtimeMs).toISOString();
    const sourceDate = new Date(srcStat.mtimeMs).toISOString();
    return {
      status: "warn",
      message: `Installed rules (${installedDate}) older than bundled (${sourceDate})`,
      fix_hint: FIX_HINT,
    };
  }
  return {
    status: "ok",
    message: `Rules up to date (installed at ${found.path})`,
    fix_hint: "",
  };
}
