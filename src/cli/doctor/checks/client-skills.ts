// Client-side skill installation check.
//
// FR-022: verify the `/chest-memory` skill is installed under
// `~/.claude/skills/chest-memory/SKILL.md`. Both the directory and the
// SKILL.md file must exist for the skill to be discoverable by the agent.

import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CheckResult } from "../types.js";

type PartialResult = Omit<CheckResult, "id" | "title" | "category" | "duration_ms">;

export interface SkillsCheckOpts {
  /** Override for tests — defaults to `os.homedir()`. */
  home?: string;
}

export async function checkSkillsDir(opts: SkillsCheckOpts = {}): Promise<PartialResult> {
  const home = opts.home ?? homedir();
  const skillDir = join(home, ".claude", "skills", "chest-memory");
  const skillFile = join(skillDir, "SKILL.md");
  try {
    const s = await stat(skillFile);
    if (!s.isFile() || s.size === 0) {
      return {
        status: "fail",
        message: `SKILL.md present but empty at ${skillFile}`,
        fix_hint: "Run: npx chest-memory-setup",
      };
    }
    return {
      status: "ok",
      message: `chest-memory skill installed at ${skillDir}`,
      fix_hint: "",
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {
        status: "fail",
        message: `Skill not installed at ${skillDir}`,
        fix_hint: "Run: npx chest-memory-setup",
      };
    }
    return {
      status: "fail",
      message: `Failed to stat ${skillFile}: ${(err as Error).message}`,
      fix_hint: "Check filesystem permissions on ~/.claude/skills",
    };
  }
}
