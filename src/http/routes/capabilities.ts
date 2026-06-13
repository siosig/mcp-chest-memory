// GET /capabilities — version negotiation and embedder advertisement.
// Contract: specs/014-doctor-healthcheck/contracts/http-capabilities.md

import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { getServerCapabilities } from "../../core/capabilities.js";
import { logger } from "../../utils/logger.js";

export function createCapabilitiesRoute(token: string): Hono {
  const app = new Hono();
  app.use(
    "*",
    bearerAuth({
      token,
      invalidTokenMessage: { error: "unauthorized" },
      noAuthenticationHeaderMessage: { error: "unauthorized" },
      invalidAuthenticationHeaderMessage: { error: "unauthorized" },
    }),
  );
  app.get("/", (c) => {
    try {
      return c.json(getServerCapabilities());
    } catch (e) {
      logger.error(
        { err: e instanceof Error ? e.message : String(e) },
        "capabilities failed",
      );
      return c.json(
        { error: "internal_error", message: e instanceof Error ? e.message : "unknown" },
        500,
      );
    }
  });
  return app;
}
