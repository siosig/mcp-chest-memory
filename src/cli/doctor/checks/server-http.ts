// Server doctor: HTTP probe checks (/healthz, /capabilities).
//
// Uses the global `fetch` available on Node 20+ and an AbortController for
// per-request timeouts. The published host port is read from
// `docker inspect`'s NetworkSettings; the bearer token (when present in
// the *current process* env) is sent so authenticated probes work — the
// token value itself is never echoed to output.

import type { CheckResult } from "../types.js";
import { dockerInspect } from "./server-docker.js";

type PartialResult = Omit<CheckResult, "id" | "title" | "category" | "duration_ms">;

const DEFAULT_CONTAINER_PORT = "8765/tcp";

export interface PortInfo {
  host: string;
  port: string;
}

export function resolvePort(container: string): { ok: true; info: PortInfo } | { ok: false; result: PartialResult } {
  const inspect = dockerInspect(container);
  if (!inspect.ok) return { ok: false, result: inspect.result };
  const ports = inspect.data.NetworkSettings?.Ports ?? {};
  const binding = ports[DEFAULT_CONTAINER_PORT];
  if (!binding || binding.length === 0) {
    return {
      ok: false,
      result: {
        status: "fail",
        message: `Container '${container}' does not publish ${DEFAULT_CONTAINER_PORT}.`,
        fix_hint:
          "Add a `ports:` mapping (e.g. `8765:8765`) in deploy/compose.override.yaml and restart the container.",
      },
    };
  }
  const first = binding[0];
  const port = first?.HostPort ?? "";
  if (!port) {
    return {
      ok: false,
      result: {
        status: "fail",
        message: `Container '${container}' has an empty HostPort binding.`,
        fix_hint: "Recreate the container with an explicit host port mapping in compose.override.yaml.",
      },
    };
  }
  // 0.0.0.0 / :: bindings are reachable via 127.0.0.1 from the same host.
  const host =
    first?.HostIp && first.HostIp !== "0.0.0.0" && first.HostIp !== "::" ? first.HostIp : "127.0.0.1";
  return { ok: true, info: { host, port } };
}

export async function fetchWithTimeout(url: string, timeoutSec: number, headers: Record<string, string>): Promise<
  | { ok: true; status: number; text: string }
  | { ok: false; error: string }
> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(100, timeoutSec * 1000));
  try {
    const r = await fetch(url, { headers, signal: controller.signal });
    const text = await r.text();
    return { ok: true, status: r.status, text };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

export function authHeaders(): Record<string, string> {
  const token = process.env["CHEST_API_TOKEN"];
  if (!token) return { Accept: "application/json" };
  return { Accept: "application/json", Authorization: `Bearer ${token}` };
}

/** GET `/healthz` on the container's published port — expect HTTP 200. */
export async function checkHealthEndpoint(container: string, timeoutSec: number): Promise<PartialResult> {
  const port = resolvePort(container);
  if (!port.ok) return port.result;
  const url = `http://${port.info.host}:${port.info.port}/healthz`;
  const r = await fetchWithTimeout(url, timeoutSec, authHeaders());
  if (!r.ok) {
    return {
      status: "fail",
      message: `GET ${url} failed: ${r.error}`,
      fix_hint:
        "Check the container is listening and the published port is correct; verify firewall / proxy rules.",
    };
  }
  if (r.status === 200) {
    return { status: "ok", message: `GET ${url} → 200`, fix_hint: "" };
  }
  return {
    status: "fail",
    message: `GET ${url} → ${r.status}`,
    fix_hint: "Inspect server logs with `docker logs <container>`.",
  };
}

/** GET `/capabilities` — expect HTTP 200 + JSON containing `api_version` & `features`. */
export async function checkCapabilitiesEndpoint(container: string, timeoutSec: number): Promise<PartialResult> {
  const port = resolvePort(container);
  if (!port.ok) return port.result;
  const url = `http://${port.info.host}:${port.info.port}/capabilities`;
  const r = await fetchWithTimeout(url, timeoutSec, authHeaders());
  if (!r.ok) {
    return {
      status: "fail",
      message: `GET ${url} failed: ${r.error}`,
      fix_hint: "Verify the server exposes /capabilities (feature 014). Upgrade the server image if missing.",
    };
  }
  if (r.status === 404) {
    return {
      status: "fail",
      message: `GET ${url} → 404 (endpoint not implemented).`,
      fix_hint: "Upgrade the server to a version that implements /capabilities (feature 014).",
    };
  }
  if (r.status === 401 || r.status === 403) {
    return {
      status: "fail",
      message: `GET ${url} → ${r.status} (authentication failed).`,
      fix_hint:
        "Set CHEST_API_TOKEN in the doctor's environment to match the server's token, or open /capabilities for unauthenticated probes.",
    };
  }
  if (r.status !== 200) {
    return {
      status: "fail",
      message: `GET ${url} → ${r.status}`,
      fix_hint: "Inspect server logs.",
    };
  }
  let body: unknown;
  try {
    body = JSON.parse(r.text);
  } catch (err) {
    return {
      status: "fail",
      message: `GET ${url} returned non-JSON body: ${err instanceof Error ? err.message : String(err)}`,
      fix_hint: "Server returned malformed /capabilities body; upgrade the server.",
    };
  }
  if (typeof body !== "object" || body === null) {
    return {
      status: "fail",
      message: `GET ${url} body is not a JSON object.`,
      fix_hint: "Server returned an unexpected /capabilities body; upgrade the server.",
    };
  }
  const obj = body as Record<string, unknown>;
  const missing: string[] = [];
  if (typeof obj["api_version"] !== "string") missing.push("api_version");
  if (!Array.isArray(obj["features"])) missing.push("features");
  if (missing.length > 0) {
    return {
      status: "fail",
      message: `/capabilities response is missing fields: ${missing.join(", ")}`,
      fix_hint: "Upgrade the server to the version that ships the complete /capabilities schema.",
    };
  }
  return {
    status: "ok",
    message: `GET ${url} → 200 (api_version=${String(obj["api_version"])})`,
    fix_hint: "",
  };
}
