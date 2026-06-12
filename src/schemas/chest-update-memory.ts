import { z } from "zod";
import { ImportanceSchema, LayerInputSchema } from "./common.js";

export const ChestUpdateMemoryInputSchema = z
  .object({
    memory_id: z.number().int().positive(),
    content: z.string().optional(),
    layer: LayerInputSchema.optional(),
    importance: ImportanceSchema.optional(),
  })
  .strict();

export type ChestUpdateMemoryInput = z.infer<typeof ChestUpdateMemoryInputSchema>;
