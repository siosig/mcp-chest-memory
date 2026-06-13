// Client-side remote server connectivity checks.
//
// FR-023 / FR-024: when running in remote mode, verify that the configured
// CHEST_REMOTE_URL responds on `/healthz` and that `/capabilities` reports
// a `min_required_client_version` we satisfy. When running in local mode
// both checks are skipped.

import { createRequire } from "node:module";
import type { CheckResult } from "../types.js";
import { validateEnv } from "../../../utils/env.js";
import { lt } from "../../../utils/semver.js";

type PartialResult = Omit<CheckResult, "id" | "title" | "category" | "duration_ms">;

const _require = createRequire(import.meta.url);
const PKG_VERSION: string = (_require("../../../../package.json") as { version: string }).version;

function resolveRemoteUrl(remoteUrl: string): string | null {
  const fromArg = remoteUrl?.trim();
  if (fromArg) return fromArg.replace(/\/+$/, "");
  const fromEnv = process.env.CHEST_REMOTE_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, "");
  return null;
}

async function fetchWithTimeout(
  url: string,
  timeoutSec: number,
): Promise<{ status: number; bodyText: string } | { error: string }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), Math.max(1, timeoutSec) * 1000);
  try {
    const token = process.env.CHEST_API_TOKEN?.trim();
    const headers: Record<string, string> = { Accept: "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(url, { signal: ctl.signal, headers });
    const bodyText = await res.text();
    return { status: res.status, bodyText };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: msg };
  } finally {
    clearTimeout(timer);
  }
}

/** FR-023: GET `<remote-url>/healthz` and expect a 2xx response. */
export async function checkRemoteConn(remoteUrl: string, timeoutSec: number): Promise<PartialResult> {
  const env = validateEnv();
  if (env.CHEST_MODE !== "remote") {
    return {
      status: "skip",
      message: "CHEST_MODE is not 'remote'; remote connectivity check skipped",
      fix_hint: "",
    };
  }
  const url = resolveRemoteUrl(remoteUrl);
  if (!url) {
    return {
      status: "fail",
      message: "CHEST_REMOTE_URL is not set and no --remote-url was provided",
      fix_hint: "Export CHEST_REMOTE_URL=<url> or pass --remote-url <url>.",
    };
  }
  const result = await fetchWithTimeout(`${url}/healthz`, timeoutSec);
  if ("error" in result) {
    return {
      status: "fail",
      message: `GET ${url}/healthz failed: ${result.error}`,
      fix_hint: "Verify the URL, network reachability, and that the chest-memory server is running.",
    };
  }
  if (result.status < 200 || result.status >= 300) {
    return {
      status: "fail",
      message: `GET ${url}/healthz returned HTTP ${result.status}`,
      fix_hint: "Inspect server logs; confirm CHEST_API_TOKEN matches between client and server.",
    };
  }
  return {
    status: "ok",
    message: `GET ${url}/healthz returned 200`,
    fix_hint: "",
  };
}

interface CapabilitiesPayload {
  api_version?: string;
  features?: string[];
  server_has_embedder?: boolean;
  min_required_client_version?: string;
}

/**
 * FR-024: GET `<remote-url>/capabilities` and verify our package version is
 * not below `min_required_client_version`.
 */
export async function checkCapabilitiesNegotiation(
  remoteUrl: string,
  timeoutSec: number,
): Promise<PartialResult> {
  const env = validateEnv();
  if (env.CHEST_MODE !== "remote") {
    return {
      status: "skip",
      message: "CHEST_MODE is not 'remote'; capabilities check skipped",
      fix_hint: "",
    };
  }
  const url = resolveRemoteUrl(remoteUrl);
  if (!url) {
    return {
      status: "fail",
      message: "CHEST_REMOTE_URL is not set and no --remote-url was provided",
      fix_hint: "Export CHEST_REMOTE_URL=<url> or pass --remote-url <url>.",
    };
  }
  const result = await fetchWithTimeout(`${url}/capabilities`, timeoutSec);
  if ("error" in result) {
    return {
      status: "fail",
      message: `GET ${url}/capabilities failed: ${result.error}`,
      fix_hint: "Verify network reachability; older servers may not expose /capabilities — upgrade the server.",
    };
  }
  if (result.status < 200 || result.status >= 300) {
    return {
      status: "fail",
      message: `GET ${url}/capabilities returned HTTP ${result.status}`,
      fix_hint: "Upgrade the server to a version that exposes /capabilities (>=1.5.0).",
    };
  }
  let payload: CapabilitiesPayload;
  try {
    payload = JSON.parse(result.bodyText) as CapabilitiesPayload;
  } catch (err) {
    return {
      status: "fail",
      message: `Capabilities response is not valid JSON: ${(err as Error).message}`,
      fix_hint: "Inspect the server response; likely a misconfigured reverse proxy.",
    };
  }
  const minRequired = payload.min_required_client_version;
  if (typeof minRequired === "string" && minRequired.length > 0 && lt(PKG_VERSION, minRequired)) {
    return {
      status: "fail",
      message: `Client version ${PKG_VERSION} is below server-required ${minRequired}`,
      fix_hint: `Upgrade mcp-chest-memory to >= ${minRequired} (e.g. npm i -g mcp-chest-memory@latest).`,
    };
  }
  const apiVersion = payload.api_version ?? "unknown";
  return {
    status: "ok",
    message: `Capabilities ok (server api_version=${apiVersion}, client=${PKG_VERSION})`,
    fix_hint: "",
  };
}
