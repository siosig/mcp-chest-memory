import { z } from "zod";
import { EntityKindSchema } from "./common.js";

export const ChestListEntitiesInputSchema = z
  .object({
    kind: EntityKindSchema.optional(),
    min_memories: z.number().int().nonnegative().optional().default(1),
    limit: z.number().int().positive().max(200).optional().default(30),
    offset: z.number().int().nonnegative().optional().default(0),
  })
  .strict();

export type ChestListEntitiesInput = z.infer<typeof ChestListEntitiesInputSchema>;
