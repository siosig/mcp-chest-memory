// REST client used by the MCP stdio server in remote mode (CHEST_MODE=remote).
// Each tool call is forwarded verbatim to the backend; the response payload is
// the same JSON string the local executor would have produced, so the MCP
// surface is byte-compatible across deployment profiles.

import type { ToolExecutor, ToolName } from "../core/executor.js";
import { ChestError } from "../utils/errors.js";

export interface RemoteExecutorOptions {
  baseUrl: string;
  token: string;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
}

interface BackendEnvelope {
  ok: boolean;
  result?: unknown;
  error?: { code?: string; message?: string };
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class RemoteExecutor implements ToolExecutor {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(opts: RemoteExecutorOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async execute(name: ToolName, args: unknown): Promise<string> {
    const url = `${this.baseUrl}/api/tools/${name}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify(args ?? {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new ChestError(
        `Backend unreachable at ${this.baseUrl}: ${e instanceof Error ? e.message : String(e)}`,
        "BACKEND_UNREACHABLE",
        "Check that the chest backend container is running and CHEST_REMOTE_URL is correct.",
      );
    }

    if (res.status === 401) {
      throw new ChestError(
        "Authentication failed (401). Check CHEST_API_TOKEN.",
        "UNAUTHORIZED",
        "The token must match the CHEST_API_TOKEN configured on the backend.",
      );
    }

    let envelope: BackendEnvelope;
    try {
      envelope = (await res.json()) as BackendEnvelope;
    } catch {
      throw new ChestError(
        `Backend returned a non-JSON response (HTTP ${res.status})`,
        "BACKEND_PROTOCOL_ERROR",
        "A reverse proxy may be intercepting the request; verify the nginx configuration.",
      );
    }

    if (!res.ok || envelope.ok !== true) {
      const code = envelope.error?.code ?? `HTTP_${res.status}`;
      const message = envelope.error?.message ?? `Backend error (HTTP ${res.status})`;
      throw new ChestError(message, code);
    }

    // The backend wraps the tool's JSON payload as a parsed object; re-serialize
    // so MCP clients receive the identical text either way.
    return typeof envelope.result === "string"
      ? envelope.result
      : JSON.stringify(envelope.result);
  }
}
