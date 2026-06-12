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
import { ChestError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

export interface CreateAppOptions {
  /** Shared bearer token. The backend refuses to start without one. */
  token: string;
  /** Injection point for tests. */
  executor?: ToolExecutor;
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

  app.use(
    "/api/*",
    bearerAuth({
      token: opts.token,
      invalidTokenMessage: errorBody("UNAUTHORIZED", "Invalid bearer token"),
      noAuthenticationHeaderMessage: errorBody("UNAUTHORIZED", "Missing Authorization header"),
      invalidAuthenticationHeaderMessage: errorBody("UNAUTHORIZED", "Malformed Authorization header"),
    }),
    bodyLimit({
      maxSize: 1024 * 1024,
      onError: (c) => c.json(errorBody("PAYLOAD_TOO_LARGE", "Request body exceeds 1MB"), 413),
    }),
  );

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
