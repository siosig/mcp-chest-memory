// POST /memories/:id/embedding — idempotent client→server embedding push.
// Contract: specs/014-doctor-healthcheck/contracts/http-pending-update.md
//
// Storage note: the existing schema persists `memories.embedding` as a JSON
// string and uses embedding_status='done' internally (not 'ok'); the client
// contract speaks 'ok' for forward compatibility. We accept the contract
// surface and write the codebase-native values to the column, keeping vector
// search (src/lib/search/vector-search.ts) and the sweep
// (src/lib/embedding/sync-embed.ts) fully interoperable.

import { createHash } from "node:crypto";
import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { z, ZodError } from "zod";
import { prisma, rawGet, rawRun } from "../../lib/db/prisma-client.js";
import { logger } from "../../utils/logger.js";

const EXPECTED_DIM = 1024;

const BodySchema = z.object({
  embedding: z
    .array(z.number().refine((n) => Number.isFinite(n), { message: "non-finite vector element" }))
    .length(EXPECTED_DIM, { message: `embedding dimension must be ${EXPECTED_DIM}` }),
  model: z.string().min(1),
  embedding_status: z.literal("ok"),
  content_sha1: z.string().optional(),
});

function sha1Hex(text: string): string {
  return createHash("sha1").update(text, "utf8").digest("hex");
}

export function createMemoriesEmbeddingRoute(token: string): Hono {
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

  app.post("/:id/embedding", async (c) => {
    const idStr = c.req.param("id");
    const id = Number(idStr);
    if (!Number.isInteger(id) || id < 1) {
      return c.json({ error: "bad_request", message: "invalid id" }, 400);
    }

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "bad_request", message: "body must be JSON" }, 400);
    }
    let body: z.infer<typeof BodySchema>;
    try {
      body = BodySchema.parse(raw);
    } catch (e) {
      const message =
        e instanceof ZodError
          ? e.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")
          : "validation error";
      return c.json({ error: "bad_request", message }, 400);
    }

    try {
      const row = await rawGet<{
        id: number;
        content: string;
        content_tokenized: string | null;
        archived_at: number | null;
      }>(
        prisma,
        `SELECT id, content, content_tokenized, archived_at
           FROM memories WHERE id = ?`,
        id,
      );
      if (!row || row.archived_at !== null) {
        return c.json({ error: "not_found" }, 404);
      }

      if (body.content_sha1) {
        const text =
          row.content_tokenized && row.content_tokenized.length > 0
            ? row.content_tokenized
            : row.content;
        const serverSha = sha1Hex(text);
        if (serverSha !== body.content_sha1) {
          return c.json({ error: "content_changed" }, 409);
        }
      }

      const jsonVec = JSON.stringify(body.embedding);
      const affected = await rawRun(
        prisma,
        `UPDATE memories
            SET embedding = ?,
                embedding_model = ?,
                embedding_dim = ?,
                embedding_status = 'done',
                embedding_state_changed_at = unixepoch()
          WHERE id = ? AND archived_at IS NULL`,
        jsonVec,
        body.model,
        EXPECTED_DIM,
        id,
      );
      if (affected === 0) {
        return c.json({ error: "not_found" }, 404);
      }

      return c.json({
        id,
        embedding_status: "ok",
        embedding_model: body.model,
        updated_at: new Date().toISOString(),
      });
    } catch (e) {
      logger.error(
        { err: e instanceof Error ? e.message : String(e), id },
        "memories-embedding update failed",
      );
      return c.json(
        { error: "internal_error", message: e instanceof Error ? e.message : "unknown" },
        500,
      );
    }
  });

  return app;
}
