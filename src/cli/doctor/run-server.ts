// Server-side doctor: orchestrates Docker / DB / compose / env / network checks.

import { runCheck, type CheckResult } from "./types.js";
import { checkDockerDaemon, checkContainerRunning, checkContainerHealth } from "./checks/server-docker.js";
import { checkComposeOverride, checkDeployRulesFile } from "./checks/server-compose.js";
import { runDbChecks } from "./checks/server-db.js";
import { checkEnvToken, checkEnvMode } from "./checks/server-env.js";
import { checkHealthEndpoint, checkCapabilitiesEndpoint } from "./checks/server-http.js";

export interface RunServerOpts {
  container: string;
  timeoutSec: number;
}

export async function runServerChecks(opts: RunServerOpts): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  results.push(await runCheck("server.docker.daemon", "Docker daemon running", "docker", () => checkDockerDaemon()));
  results.push(await runCheck("server.docker.container", `Container '${opts.container}' running`, "docker", () => checkContainerRunning(opts.container)));
  results.push(await runCheck("server.docker.health", "Container healthcheck", "docker", () => checkContainerHealth(opts.container)));

  results.push(await runCheck("server.compose.override", "compose.override.yaml applied", "compose", () => checkComposeOverride(opts.container)));
  results.push(await runCheck("server.compose.deploy_files", "Rules file packaged into image", "compose", () => checkDeployRulesFile(opts.container)));

  // All five DB checks share a single GET /diagnostics/db round-trip.
  results.push(...(await runDbChecks(opts.container, opts.timeoutSec)));

  results.push(await runCheck("server.env.token", "CHEST_API_TOKEN set", "env", () => checkEnvToken(opts.container)));
  results.push(await runCheck("server.env.mode", "CHEST_MODE=remote", "env", () => checkEnvMode(opts.container)));

  results.push(await runCheck("server.network.health", "/healthz endpoint reachable", "network", () => checkHealthEndpoint(opts.container, opts.timeoutSec)));
  results.push(await runCheck("server.network.capabilities", "/capabilities endpoint reachable", "network", () => checkCapabilitiesEndpoint(opts.container, opts.timeoutSec)));

  return results;
}
