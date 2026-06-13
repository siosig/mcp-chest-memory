// Client-side MCP registration checks.
//
// FR-020: verify chest-memory is registered in at least one MCP config file
// (project-scoped `<cwd>/.mcp.json` or user-scoped `~/.claude.json`). When
// both register the same server, warn about the duplicate.
//
// All checks read JSON files via `node:fs.readFile` and look for the
// top-level `mcpServers["chest-memory"]` entry. Missing files yield `skip`,
// not `fail`, because most installs only use one of the two locations.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CheckResult } from "../types.js";

const SERVER_NAME = "chest-memory";
const SETUP_HINT = "Run: npx chest-memory-setup";

type PartialResult = Omit<CheckResult, "id" | "title" | "category" | "duration_ms">;

export interface McpCheckOpts {
  /** Override for tests — defaults to `process.cwd()`. */
  cwd?: string;
  /** Override for tests — defaults to `os.homedir()`. */
  home?: string;
}

interface McpJson {
  mcpServers?: Record<string, unknown>;
}

async function readMcpJson(path: string): Promise<McpJson | "missing" | "bad"> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "missing";
    return "bad";
  }
  try {
    return JSON.parse(raw) as McpJson;
  } catch {
    return "bad";
  }
}

function hasChestServer(conf: McpJson): boolean {
  return Boolean(conf.mcpServers && Object.prototype.hasOwnProperty.call(conf.mcpServers, SERVER_NAME));
}

/** Check `<cwd>/.mcp.json` for a `chest-memory` registration. */
export async function checkMcpProject(opts: McpCheckOpts = {}): Promise<PartialResult> {
  const cwd = opts.cwd ?? process.cwd();
  const path = join(cwd, ".mcp.json");
  const conf = await readMcpJson(path);
  if (conf === "missing") {
    return {
      status: "skip",
      message: `No project-scoped MCP config at ${path}`,
      fix_hint: "",
    };
  }
  if (conf === "bad") {
    return {
      status: "fail",
      message: `Failed to parse ${path} (invalid JSON)`,
      fix_hint: `Open ${path} and fix the JSON syntax, then re-run.`,
    };
  }
  if (!hasChestServer(conf)) {
    return {
      status: "fail",
      message: `chest-memory not registered in ${path}`,
      fix_hint: SETUP_HINT,
    };
  }
  return {
    status: "ok",
    message: `chest-memory registered in ${path}`,
    fix_hint: "",
  };
}

/** Check `~/.claude.json` for a `chest-memory` registration. */
export async function checkMcpUser(opts: McpCheckOpts = {}): Promise<PartialResult> {
  const home = opts.home ?? homedir();
  const path = join(home, ".claude.json");
  const conf = await readMcpJson(path);
  if (conf === "missing") {
    return {
      status: "fail",
      message: `User-scoped MCP config not found at ${path}`,
      fix_hint: SETUP_HINT,
    };
  }
  if (conf === "bad") {
    return {
      status: "fail",
      message: `Failed to parse ${path} (invalid JSON)`,
      fix_hint: `Open ${path} and fix the JSON syntax, then re-run.`,
    };
  }
  if (!hasChestServer(conf)) {
    return {
      status: "fail",
      message: `chest-memory not registered in ${path}`,
      fix_hint: SETUP_HINT,
    };
  }
  return {
    status: "ok",
    message: `chest-memory registered in ${path}`,
    fix_hint: "",
  };
}

/**
 * Warn when chest-memory is registered in both project and user configs.
 * Duplicate registrations are not broken per se, but they confuse `claude`
 * about which config to honour; surfacing as warn lets the user choose.
 */
export async function checkMcpDuplicate(opts: McpCheckOpts = {}): Promise<PartialResult> {
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? homedir();
  const projectPath = join(cwd, ".mcp.json");
  const userPath = join(home, ".claude.json");

  const [project, user] = await Promise.all([readMcpJson(projectPath), readMcpJson(userPath)]);

  const inProject = typeof project === "object" && hasChestServer(project);
  const inUser = typeof user === "object" && hasChestServer(user);

  if (inProject && inUser) {
    return {
      status: "warn",
      message: `chest-memory is registered in BOTH ${projectPath} and ${userPath}`,
      fix_hint: `Remove the duplicate "mcpServers.${SERVER_NAME}" entry from one of the two files.`,
    };
  }
  return {
    status: "ok",
    message: "No duplicate MCP registration detected",
    fix_hint: "",
  };
}
