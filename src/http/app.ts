// REST backend for the LAN/WAN deployment profiles.
//
// Tool-level RPC: POST /api/tools/{toolName} executes through the same
// LocalExecutor the MCP server uses in local mode, which guarantees identical
// tool semantics across every deployment profile.

import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { bodyLimit } from "hono/body-limit";
import { ZodError } from "zod";

import { LocalExecutor, isToolName, type ToolExecutor } from "../core/executor.js";
import { prisma } from "../lib/db/prisma-client.js";
import { activeProvider } from "../lib/embedding/provider.js";
import { createHookRecallFacade } from "../lib/recall/factory.js";
import type { HookRecallFacade } from "../lib/recall/hook-recall-facade.js";
import { saveSnapshot, loadSnapshot } from "../lib/snapshot/store.js";
import { importSessionContent } from "../lib/session-import.js";
import { HookRecallRequestSchema, normalizeHookRecallRequest } from "../schemas/hook-recall.js";
import { ChestError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

export interface CreateAppOptions {
  /** Shared bearer token. The backend refuses to start without one. */
  token: string;
  /** Injection point for tests. */
  executor?: ToolExecutor;
  /** Injection point for hook recall tests and alternate recall strategies. */
  hookRecallFacade?: HookRecallFacade;
  /** Server version reported by /healthz. */
  version?: string;
}

interface ErrorBody {
  ok: false;
  error: { code: string; message: string; hint?: string };
}

function errorBody(code: string, message: string, hint?: string): ErrorBody {
  return { ok: false, error: { code, message, ...(hint ? { hint } : {}) } };
}

export function createApp(opts: CreateAppOptions): Hono {
  if (!opts.token) {
    throw new Error("CHEST_API_TOKEN is required — refusing to start an unauthenticated backend");
  }
  const executor = opts.executor ?? new LocalExecutor();
  const hookRecallFacade = opts.hookRecallFacade ?? createHookRecallFacade();
  const app = new Hono();

  // Access log (no token, no body).
  app.use("*", async (c, next) => {
    const start = Date.now();
    await next();
    logger.info(
      { method: c.req.method, path: c.req.path, status: c.res.status, ms: Date.now() - start },
      "http",
    );
  });

  // Health endpoint is unauthenticated for Docker HEALTHCHECK / nginx upstream probes.
  app.get("/healthz", async (c) => {
    const provider = activeProvider();
    let dbOk = false;
    try {
      await prisma.$queryRaw`SELECT 1 AS ok`;
      dbOk = true;
    } catch {
      dbOk = false;
    }
    const body = {
      ok: dbOk,
      version: opts.version ?? "1.0.0",
      db: dbOk ? "ok" : "error",
      embedding: { provider: provider.id, model: provider.model, dim: provider.dim },
    };
    return c.json(body, dbOk ? 200 : 503);
  });

  // Bearer auth covers all /api/* routes.
  app.use(
    "/api/*",
    bearerAuth({
      token: opts.token,
      invalidTokenMessage: errorBody("UNAUTHORIZED", "Invalid bearer token"),
      noAuthenticationHeaderMessage: errorBody("UNAUTHORIZED", "Missing Authorization header"),
      invalidAuthenticationHeaderMessage: errorBody("UNAUTHORIZED", "Malformed Authorization header"),
    }),
  );

  // Tool calls: 1 MB body limit (JSON tool payloads are small).
  app.use("/api/tools/*", bodyLimit({
    maxSize: 1024 * 1024,
    onError: (c) => c.json(errorBody("PAYLOAD_TOO_LARGE", "Request body exceeds 1MB"), 413),
  }));

  // Hook: session JSONL can be several MB; allow up to 50 MB.
  app.use("/api/hooks/sync-session", bodyLimit({
    maxSize: 50 * 1024 * 1024,
    onError: (c) => c.json(errorBody("PAYLOAD_TOO_LARGE", "Request body exceeds 50MB"), 413),
  }));

  // Hook: snapshot/precompact payloads are tiny.
  app.use("/api/hooks/precompact", bodyLimit({
    maxSize: 64 * 1024,
    onError: (c) => c.json(errorBody("PAYLOAD_TOO_LARGE", "Request body exceeds 64KB"), 413),
  }));

  app.use("/api/hooks/recall", bodyLimit({
    maxSize: 64 * 1024,
    onError: (c) => c.json(errorBody("PAYLOAD_TOO_LARGE", "Request body exceeds 64KB"), 413),
  }));

  // ── Hook endpoints ────────────────────────────────────
  // POST /api/hooks/sync-session
  // Body: raw JSONL text (Content-Type: text/plain)
  // Header: X-Session-Id — used only for logging
  app.post("/api/hooks/sync-session", async (c) => {
    const headerSessionId = c.req.header("X-Session-Id") ?? "unknown";
    let content: string;
    try {
      content = await c.req.text();
    } catch {
      return c.json(errorBody("VALIDATION_ERROR", "Could not read request body"), 400);
    }
    if (!content.trim()) {
      return c.json({ ok: true, skipped: true, reason: "empty content" });
    }
    try {
      const result = await importSessionContent(content);
      if (!result) return c.json({ ok: true, skipped: true, reason: "empty or invalid session" });
      logger.info({ headerSessionId, ...result }, "hook:sync-session imported");
      return c.json({ ok: true, ...result });
    } catch (e) {
      logger.error({ err: e instanceof Error ? e.message : String(e), headerSessionId }, "hook:sync-session failed");
      return c.json(errorBody("INTERNAL_ERROR", "Session import failed"), 500);
    }
  });

  // POST /api/hooks/precompact
  // Body: { session_id: string }
  app.post("/api/hooks/precompact", async (c) => {
    let body: { session_id?: string };
    try {
      body = await c.req.json() as { session_id?: string };
    } catch {
      return c.json(errorBody("VALIDATION_ERROR", "Request body must be JSON"), 400);
    }
    const sessionId = body.session_id;
    if (!sessionId) return c.json(errorBody("VALIDATION_ERROR", "session_id is required"), 400);
    try {
      const text = await saveSnapshot(sessionId);
      const saved = text !== "";
      logger.info({ sessionId, saved }, "hook:precompact");
      return c.json({ ok: true, saved });
    } catch (e) {
      logger.error({ err: e instanceof Error ? e.message : String(e), sessionId }, "hook:precompact failed");
      return c.json(errorBody("INTERNAL_ERROR", "Snapshot save failed"), 500);
    }
  });

  // GET /api/hooks/snapshot/:sessionId
  app.get("/api/hooks/snapshot/:sessionId", async (c) => {
    const sessionId = c.req.param("sessionId");
    try {
      const text = await loadSnapshot(sessionId);
      if (text === null) return c.json(errorBody("NOT_FOUND", "No snapshot found for this session"), 404);
      return c.json({ ok: true, text });
    } catch (e) {
      logger.error({ err: e instanceof Error ? e.message : String(e), sessionId }, "hook:snapshot failed");
      return c.json(errorBody("INTERNAL_ERROR", "Snapshot load failed"), 500);
    }
  });

  // POST /api/hooks/recall
  // Body: { query, project?, layers?, limit?, max_tokens? }
  app.post("/api/hooks/recall", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json(errorBody("VALIDATION_ERROR", "Request body must be JSON"), 400);
    }
    try {
      const request = normalizeHookRecallRequest(HookRecallRequestSchema.parse(raw));
      const response = await hookRecallFacade.recall(request);
      return c.json(response);
    } catch (e) {
      if (e instanceof ZodError) {
        const summary = e.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ");
        return c.json(errorBody("VALIDATION_ERROR", summary), 400);
      }
      logger.error({ err: e instanceof Error ? e.message : String(e) }, "hook:recall failed");
      return c.json(errorBody("INTERNAL_ERROR", "Recall failed"), 500);
    }
  });

  // ── Tool endpoint ─────────────────────────────────────
  app.post("/api/tools/:toolName", async (c) => {
    const toolName = c.req.param("toolName");
    if (!isToolName(toolName)) {
      return c.json(errorBody("UNKNOWN_TOOL", `Unknown tool: ${toolName}`), 404);
    }

    let args: unknown;
    try {
      args = await c.req.json();
    } catch {
      return c.json(errorBody("VALIDATION_ERROR", "Request body must be JSON"), 400);
    }

    try {
      const resultJson = await executor.execute(toolName, args);
      let result: unknown;
      try {
        result = JSON.parse(resultJson);
      } catch {
        result = resultJson;
      }
      return c.json({ ok: true, result });
    } catch (e) {
      if (e instanceof ZodError) {
        const summary = e.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ");
        return c.json(errorBody("VALIDATION_ERROR", summary), 400);
      }
      if (e instanceof ChestError) {
        // Domain errors travel with their code so the remote-mode MCP client
        // reproduces the exact local-mode error payload.
        return c.json(errorBody(e.code, e.message, e.hint), 400);
      }
      logger.error({ err: e instanceof Error ? e.message : String(e) }, "tool execution failed");
      return c.json(errorBody("INTERNAL_ERROR", "Internal server error"), 500);
    }
  });

  app.notFound((c) => c.json(errorBody("NOT_FOUND", "Not found"), 404));

  return app;
}
