// Client-side doctor: orchestrates MCP / rules / skills / model / connectivity checks.

import { runCheck, type CheckResult } from "./types.js";
import { checkMcpProject, checkMcpUser, checkMcpDuplicate } from "./checks/client-mcp.js";
import { checkRulesExists, checkRulesFresh } from "./checks/client-rules.js";
import { checkSkillsDir } from "./checks/client-skills.js";
import { checkRemoteConn, checkCapabilitiesNegotiation } from "./checks/client-server-conn.js";
import { checkModelCache } from "./checks/client-model-cache.js";
import { checkLocalDb } from "./checks/client-local-db.js";

export interface RunClientOpts {
  remoteUrl: string;
  timeoutSec: number;
}

export async function runClientChecks(opts: RunClientOpts): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  results.push(await runCheck("client.mcp.project", "Project .mcp.json registration", "config", () => checkMcpProject()));
  results.push(await runCheck("client.mcp.user", "User ~/.claude.json registration", "config", () => checkMcpUser()));
  results.push(await runCheck("client.mcp.duplicate", "No duplicate registrations", "config", () => checkMcpDuplicate()));

  results.push(await runCheck("client.rules.exists", "Rules file present", "config", () => checkRulesExists()));
  results.push(await runCheck("client.rules.fresh", "Rules file up to date", "config", () => checkRulesFresh()));

  results.push(await runCheck("client.skills.chest", "chest-memory skill installed", "config", () => checkSkillsDir()));

  results.push(await runCheck("client.local.db", "Local DB writable (local mode)", "db", () => checkLocalDb()));

  results.push(await runCheck("client.network.health", "Remote /healthz reachable", "network", () => checkRemoteConn(opts.remoteUrl, opts.timeoutSec)));
  results.push(await runCheck("client.network.capabilities", "API version compatible", "network", () => checkCapabilitiesNegotiation(opts.remoteUrl, opts.timeoutSec)));

  results.push(await runCheck("client.model.cache", "Embedding model cached", "model", () => checkModelCache()));

  return results;
}
