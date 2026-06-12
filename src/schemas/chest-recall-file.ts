import { z } from "zod";

export const ChestRecallFileInputSchema = z
  .object({
    path_substring: z.string().min(1),
    max_intents: z.number().int().positive().max(50).optional().default(10),
    scope_to_roots: z
      .boolean()
      .optional()
      .default(false)
      .describe("When true, filter results to paths inside the client's declared roots."),
  })
  .strict();

export type ChestRecallFileInput = z.infer<typeof ChestRecallFileInputSchema>;
