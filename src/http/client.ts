// REST client used by the MCP stdio server in remote mode (CHEST_MODE=remote).
// Each tool call is forwarded verbatim to the backend; the response payload is
// the same JSON string the local executor would have produced, so the MCP
// surface is byte-compatible across deployment profiles.

import type { ToolExecutor, ToolName } from "../core/executor.js";
import type { ServerCapabilities } from "../core/capabilities.js";
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

// ────────────────────────────────────────────────────────────────────────────
// Reliability bundle (feature 014) client helpers.
// These hit the root-level endpoints (/capabilities, /memories/pending,
// /memories/:id/embedding) that backend exposes outside the /api/* namespace.
// ────────────────────────────────────────────────────────────────────────────

export interface PendingMemoryItem {
  id: number;
  content: string;
  text_for_embedding: string;
}

export interface PendingListResponse {
  items: PendingMemoryItem[];
  next_cursor: number;
  remaining: number;
}

export interface CapabilitiesClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
}

export class CapabilitiesClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private cachedCapabilities: ServerCapabilities | undefined;

  constructor(opts: CapabilitiesClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** GET /capabilities, memoized per instance. */
  async getCapabilities(): Promise<ServerCapabilities> {
    if (this.cachedCapabilities) return this.cachedCapabilities;
    const res = await this.fetchJson("/capabilities", { method: "GET" });
    if (res.status === 401) {
      throw new ChestError("Authentication failed (401)", "UNAUTHORIZED");
    }
    if (!res.ok) {
      throw new ChestError(
        `Capabilities request failed (HTTP ${res.status})`,
        `HTTP_${res.status}`,
      );
    }
    const body = (await res.json()) as ServerCapabilities;
    this.cachedCapabilities = body;
    return body;
  }

  async listPending(cursor: number, limit: number): Promise<PendingListResponse> {
    const url = `/memories/pending?cursor=${cursor}&limit=${limit}`;
    const res = await this.fetchJson(url, { method: "GET" });
    if (res.status === 401) {
      throw new ChestError("Authentication failed (401)", "UNAUTHORIZED");
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      throw new ChestError(
        body.message ?? `pending list failed (HTTP ${res.status})`,
        `HTTP_${res.status}`,
      );
    }
    return (await res.json()) as PendingListResponse;
  }

  async updateEmbedding(
    id: number,
    vector: number[],
    model: string,
    contentSha1?: string,
  ): Promise<void> {
    const url = `/memories/${id}/embedding`;
    const res = await this.fetchJson(url, {
      method: "POST",
      body: JSON.stringify({
        embedding: vector,
        model,
        embedding_status: "ok",
        ...(contentSha1 ? { content_sha1: contentSha1 } : {}),
      }),
    });
    if (res.status === 200) return;
    if (res.status === 401) throw new ChestError("Authentication failed (401)", "UNAUTHORIZED");
    if (res.status === 404) throw new ChestError(`memory ${id} not found`, "NOT_FOUND");
    if (res.status === 409) throw new ChestError(`content changed for ${id}`, "CONTENT_CHANGED");
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new ChestError(
      body.message ?? `embedding update failed (HTTP ${res.status})`,
      `HTTP_${res.status}`,
    );
  }

  private async fetchJson(
    path: string,
    init: { method: "GET" | "POST"; body?: string },
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    try {
      return await fetch(url, {
        method: init.method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(init.body ? { "content-type": "application/json" } : {}),
        },
        body: init.body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new ChestError(
        `Backend unreachable at ${this.baseUrl}: ${e instanceof Error ? e.message : String(e)}`,
        "BACKEND_UNREACHABLE",
      );
    }
  }
}

