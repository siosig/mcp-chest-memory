import { z } from "zod";
import { ImportanceSchema, LayerInputSchema } from "./common.js";
import { MAX_CONTENT_CHARS } from "../lib/embedding/config.js";

export const ChestUpdateMemoryInputSchema = z
  .object({
    memory_id: z.number().int().positive(),
    // Same cap as chest_remember — update must not be a way to bypass it.
    content: z.string().max(MAX_CONTENT_CHARS).optional(),
    layer: LayerInputSchema.optional(),
    importance: ImportanceSchema.optional(),
  })
  .strict();

export type ChestUpdateMemoryInput = z.infer<typeof ChestUpdateMemoryInputSchema>;
