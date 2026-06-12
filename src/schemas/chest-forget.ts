import { z } from "zod";

export const ChestForgetInputSchema = z
  .object({
    memory_id: z.number().int().positive().optional(),
    dry_run: z.boolean().optional().default(false),
    interactive: z
      .boolean()
      .optional()
      .default(false)
      .describe("Ask the user for confirmation via elicitation before deleting. Only applies when memory_id is specified."),
  })
  .strict();

export type ChestForgetInput = z.infer<typeof ChestForgetInputSchema>;
