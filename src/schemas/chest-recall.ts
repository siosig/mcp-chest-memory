import { z } from "zod";
import { HeatBandSchema, LayerInputSchema } from "./common.js";

// `query` is optional because `ids` can substitute for it (direct fetch by ID).
// The "query or ids required" invariant is enforced in the handler rather than here,
// because the MCP SDK requires a plain ZodObject for inputSchema (ZodEffects is not accepted).
export const ChestRecallInputSchema = z
  .object({
    query: z.string().min(1).optional().describe("Free-text search query or FTS5 MATCH expression. Required when ids is not provided."),
    entity_name: z.string().optional().describe("Optional — narrow to a specific entity"),
    layer: LayerInputSchema.optional(),
    band: HeatBandSchema.optional(),
    max_tokens: z.number().int().positive().optional().default(2000),
    limit: z.number().int().positive().max(200).optional(),
    offset: z.number().int().nonnegative().optional().default(0),
    mark_accessed: z.boolean().optional().default(true),
    include_archived: z
      .boolean()
      .optional()
      .default(false)
      .describe("Include memories that have been archived (archived_at IS NOT NULL)."),
    include_superseded: z
      .boolean()
      .optional()
      .default(false)
      .describe("Include memories that have been superseded (superseded_by_id IS NOT NULL)."),
    ignore_decay: z
      .boolean()
      .optional()
      .default(false)
      .describe("Disable time-based decay by treating activation, TTL, and supersession penalty factors as 1.0."),
    snippet_mode: z
      .boolean()
      .optional()
      .default(false)
      .describe("Replace each memory's content with a snippet around the query terms. Truncated memories include content_truncated: true."),
    snippet_window: z
      .number()
      .int()
      .min(40)
      .max(2000)
      .optional()
      .default(240)
      .describe("Width of the snippet window in code points."),
    ids: z
      .array(z.number().int().positive())
      .min(1)
      .max(200)
      .optional()
      .describe("When provided, skip query-based search and fetch these memory IDs directly (always full content; snippet_mode is ignored)."),
  })
  .strict();

export type ChestRecallInput = z.infer<typeof ChestRecallInputSchema>;
