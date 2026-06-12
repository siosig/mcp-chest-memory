import { z } from "zod";
import { EntityKindSchema, ImportanceSchema, LayerInputSchema, MomentumBandSchema } from "./common.js";
import { MAX_CONTENT_CHARS } from "../lib/embedding/config.js";

export const ChestRememberInputSchema = z
  .object({
    entity_name: z.string().min(1).describe("Name of the entity this memory is about"),
    entity_kind: EntityKindSchema,
    entity_key: z.string().optional().describe("Optional canonical key (email, domain, file path)"),
    layer: LayerInputSchema,
    content: z
      .string()
      .min(1)
      .max(
        MAX_CONTENT_CHARS,
        `Content too long: exceeds limit ${MAX_CONTENT_CHARS} chars. Please split into smaller memories.`,
      )
      .describe("The memory content (plain text or JSON)"),
    importance: ImportanceSchema.optional().default(0.5),
    force: z
      .boolean()
      .optional()
      .default(false)
      .describe("Bypass the paste-back/CI-log quality check"),
    expires_at: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Expiry timestamp (Unix epoch seconds). Omit to apply the layer-default TTL."),
    supersedes: z
      .array(z.number().int().positive())
      .optional()
      .describe("IDs of existing memories that this memory explicitly supersedes. They are archived immediately."),
  })
  .strict();

export type ChestRememberInput = z.infer<typeof ChestRememberInputSchema>;

export const ChestRememberResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    memory_id: z.number(),
    entity_id: z.number(),
    layer: z.string(),
    pinned: z.boolean(),
    momentum: z.object({ score: z.number(), band: MomentumBandSchema }),
  }),
  z.object({
    ok: z.literal(false),
    rejected: z.string().optional(),
    reason: z.string().optional(),
    error: z.string().optional(),
    hint: z.string().optional(),
  }),
]);
export type ChestRememberResult = z.infer<typeof ChestRememberResultSchema>;
