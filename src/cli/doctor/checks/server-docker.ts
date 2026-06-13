// Server doctor: Docker daemon and container checks.
//
// Uses `child_process.spawnSync` to invoke the `docker` CLI directly,
// avoiding any new npm dependency such as dockerode. All functions return
// a partial CheckResult (status/message/fix_hint) — the caller wraps with
// runCheck() to attach id/title/category/duration_ms.

import { spawnSync } from "node:child_process";
import type { CheckResult } from "../types.js";

type PartialResult = Omit<CheckResult, "id" | "title" | "category" | "duration_ms">;

const DOCKER_TIMEOUT_MS = 5000;

interface DockerInspect {
  State?: {
    Running?: boolean;
    Status?: string;
    Health?: { Status?: string };
  };
  Config?: {
    Env?: string[];
    Labels?: Record<string, string>;
  };
  NetworkSettings?: {
    Ports?: Record<string, Array<{ HostPort?: string; HostIp?: string }> | null>;
  };
}

/** Run `docker info` to verify the daemon is reachable. */
export async function checkDockerDaemon(): Promise<PartialResult> {
  const r = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
    encoding: "utf8",
    timeout: DOCKER_TIMEOUT_MS,
  });
  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {
        status: "fail",
        message: "`docker` CLI not found in PATH.",
        fix_hint:
          "Install Docker (https://docs.docker.com/get-docker/) or add the docker binary to PATH.",
      };
    }
    return {
      status: "fail",
      message: `docker info failed: ${r.error.message}`,
      fix_hint: "Start the Docker daemon and ensure the current user can access the docker socket.",
    };
  }
  if (r.status !== 0) {
    return {
      status: "fail",
      message: `docker info exited ${r.status}: ${(r.stderr ?? "").trim()}`,
      fix_hint:
        "Start the Docker daemon (e.g. `sudo systemctl start docker`) and ensure the user is in the `docker` group.",
    };
  }
  return {
    status: "ok",
    message: `Docker daemon reachable (server ${(r.stdout ?? "").trim() || "unknown"}).`,
    fix_hint: "",
  };
}

/** Inspect the container and verify it is in the `running` state. */
export async function checkContainerRunning(name: string): Promise<PartialResult> {
  const inspect = dockerInspect(name);
  if (!inspect.ok) return inspect.result;
  const running = inspect.data.State?.Running === true;
  const status = inspect.data.State?.Status ?? "unknown";
  if (running) {
    return {
      status: "ok",
      message: `Container '${name}' is running (status=${status}).`,
      fix_hint: "",
    };
  }
  return {
    status: "fail",
    message: `Container '${name}' is not running (status=${status}).`,
    fix_hint: `docker compose -f deploy/docker/compose.yaml -f deploy/docker/compose.override.yaml up -d`,
  };
}

/** Verify the container healthcheck reports `healthy`. */
export async function checkContainerHealth(name: string): Promise<PartialResult> {
  const inspect = dockerInspect(name);
  if (!inspect.ok) return inspect.result;
  const health = inspect.data.State?.Health?.Status;
  if (health === undefined) {
    return {
      status: "skip",
      message: `Container '${name}' has no HEALTHCHECK defined.`,
      fix_hint: "Add a HEALTHCHECK to the image or compose file to enable this probe.",
    };
  }
  if (health === "healthy") {
    return {
      status: "ok",
      message: `Container '${name}' health=healthy.`,
      fix_hint: "",
    };
  }
  if (health === "starting") {
    return {
      status: "warn",
      message: `Container '${name}' health=starting (still initializing).`,
      fix_hint: "Wait a few seconds and re-run; if it stays in `starting`, inspect the container logs.",
    };
  }
  return {
    status: "fail",
    message: `Container '${name}' health=${health}.`,
    fix_hint: `docker logs ${name} --tail 100`,
  };
}

interface InspectOk {
  ok: true;
  data: DockerInspect;
}
interface InspectFail {
  ok: false;
  result: PartialResult;
}

/** Run `docker inspect` and parse the JSON output for downstream checks. */
export function dockerInspect(name: string): InspectOk | InspectFail {
  const r = spawnSync("docker", ["inspect", "--format", "{{json .}}", name], {
    encoding: "utf8",
    timeout: DOCKER_TIMEOUT_MS,
  });
  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {
        ok: false,
        result: {
          status: "fail",
          message: "`docker` CLI not found in PATH.",
          fix_hint: "Install Docker so this check can inspect containers.",
        },
      };
    }
    return {
      ok: false,
      result: {
        status: "fail",
        message: `docker inspect failed: ${r.error.message}`,
        fix_hint: "Check Docker daemon status and permissions.",
      },
    };
  }
  if (r.status !== 0) {
    const stderr = (r.stderr ?? "").trim();
    return {
      ok: false,
      result: {
        status: "fail",
        message: `docker inspect '${name}' exited ${r.status}: ${stderr || "no such container"}`,
        fix_hint: `Start the container: docker compose -f deploy/docker/compose.yaml -f deploy/docker/compose.override.yaml up -d`,
      },
    };
  }
  try {
    const data = JSON.parse((r.stdout ?? "").trim()) as DockerInspect;
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      result: {
        status: "fail",
        message: `Failed to parse docker inspect output: ${err instanceof Error ? err.message : String(err)}`,
        fix_hint: "Re-run the check; if it persists, file a bug.",
      },
    };
  }
}
