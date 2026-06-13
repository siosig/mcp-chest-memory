// Server doctor: compose override + deploy artifacts checks.
//
// Historical incidents this guards against:
//   - Memory ID 5134: starting the container without the override file makes
//     the data dir owned by root, causing a readonly DB crash.
//   - Memory ID 5135: missing `deploy/mcp-chest-memory.md` inside the image
//     means the rules file is never installed on client setups.

import { spawnSync } from "node:child_process";
import type { CheckResult } from "../types.js";
import { dockerInspect } from "./server-docker.js";

type PartialResult = Omit<CheckResult, "id" | "title" | "category" | "duration_ms">;

const DOCKER_TIMEOUT_MS = 5000;
const OVERRIDE_NAME = "compose.override.yaml";
const RULES_PATH_IN_IMAGE = "/app/dist/rules/mcp-chest-memory.md";
const COMPOSE_FIX_HINT =
  "docker compose -f deploy/compose.yaml -f deploy/compose.override.yaml up -d";

/**
 * Verify the running container was started with `compose.override.yaml`.
 * The `com.docker.compose.project.config_files` label lists every compose
 * file passed via `-f`. If the override is absent, fail with the canonical
 * fix command in fix_hint.
 */
export async function checkComposeOverride(name: string): Promise<PartialResult> {
  const inspect = dockerInspect(name);
  if (!inspect.ok) return inspect.result;
  const label = inspect.data.Config?.Labels?.["com.docker.compose.project.config_files"] ?? "";
  if (label === "") {
    return {
      status: "warn",
      message:
        "Container has no `com.docker.compose.project.config_files` label — not launched via docker compose?",
      fix_hint: COMPOSE_FIX_HINT,
    };
  }
  const files = label.split(",").map((s) => s.trim());
  const hasOverride = files.some((f) => f.endsWith(OVERRIDE_NAME) || f.includes("/" + OVERRIDE_NAME));
  if (hasOverride) {
    return {
      status: "ok",
      message: `compose.override.yaml is applied (files: ${files.join(", ")}).`,
      fix_hint: "",
    };
  }
  return {
    status: "fail",
    message: `compose.override.yaml is NOT applied (files: ${files.join(", ")}).`,
    fix_hint: COMPOSE_FIX_HINT,
  };
}

/**
 * Verify the deploy-time rules file exists inside the running image.
 * Runs `docker exec <container> test -f <path>`. exit code 0 = present.
 */
export async function checkDeployRulesFile(name: string): Promise<PartialResult> {
  const r = spawnSync("docker", ["exec", name, "test", "-f", RULES_PATH_IN_IMAGE], {
    encoding: "utf8",
    timeout: DOCKER_TIMEOUT_MS,
  });
  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {
        status: "fail",
        message: "`docker` CLI not found in PATH.",
        fix_hint: "Install Docker so this check can exec into containers.",
      };
    }
    return {
      status: "fail",
      message: `docker exec failed: ${r.error.message}`,
      fix_hint: "Ensure the container is running and accessible.",
    };
  }
  if (r.status === 0) {
    return {
      status: "ok",
      message: `Rules file ${RULES_PATH_IN_IMAGE} is present in the image.`,
      fix_hint: "",
    };
  }
  return {
    status: "fail",
    message: `Rules file ${RULES_PATH_IN_IMAGE} is missing from the image (Dockerfile COPY likely omitted deploy/).`,
    fix_hint:
      "Rebuild the image with `deploy/mcp-chest-memory.md` included: docker compose -f deploy/compose.yaml -f deploy/compose.override.yaml build --no-cache && docker compose -f deploy/compose.yaml -f deploy/compose.override.yaml up -d",
  };
}
