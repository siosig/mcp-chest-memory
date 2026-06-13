// GET /memories/pending — cursor-paged list of memories awaiting embedding.
// Contract: specs/014-doctor-healthcheck/contracts/http-pending-list.md

import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { prisma, rawAll, rawGet } from "../../lib/db/prisma-client.js";
import { logger } from "../../utils/logger.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

interface PendingRow {
  id: number;
  content: string;
  content_tokenized: string | null;
}

export function createMemoriesPendingRoute(token: string): Hono {
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
  app.get("/", async (c) => {
    const limitRaw = c.req.query("limit");
    const cursorRaw = c.req.query("cursor");
    const limit = limitRaw === undefined ? DEFAULT_LIMIT : Number(limitRaw);
    const cursor = cursorRaw === undefined ? 0 : Number(cursorRaw);

    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      return c.json(
        {
          error: "bad_request",
          message: `limit must be an integer between 1 and ${MAX_LIMIT}`,
        },
        400,
      );
    }
    if (!Number.isInteger(cursor) || cursor < 0) {
      return c.json(
        { error: "bad_request", message: "cursor must be a non-negative integer" },
        400,
      );
    }

    try {
      const rows = await rawAll<PendingRow>(
        prisma,
        `SELECT id, content, content_tokenized
           FROM memories
          WHERE embedding_status = 'pending'
            AND archived_at IS NULL
            AND id > ?
            AND length(coalesce(content_tokenized, content)) > 0
          ORDER BY id ASC
          LIMIT ?`,
        cursor,
        limit,
      );
      const items = rows.map((r) => ({
        id: r.id,
        content: r.content,
        text_for_embedding:
          r.content_tokenized && r.content_tokenized.length > 0 ? r.content_tokenized : r.content,
      }));
      const next_cursor = items.length === 0 ? 0 : (items[items.length - 1]?.id ?? 0);

      const remRow = await rawGet<{ c: number }>(
        prisma,
        `SELECT COUNT(*) AS c FROM memories
          WHERE embedding_status = 'pending' AND archived_at IS NULL`,
      );
      const remaining = remRow?.c ?? 0;

      return c.json({ items, next_cursor, remaining });
    } catch (e) {
      logger.error(
        { err: e instanceof Error ? e.message : String(e) },
        "memories-pending failed",
      );
      return c.json(
        { error: "internal_error", message: e instanceof Error ? e.message : "unknown" },
        500,
      );
    }
  });
  return app;
}
