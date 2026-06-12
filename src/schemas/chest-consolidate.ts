import { z } from "zod";

export const ChestConsolidateInputSchema = z
  .object({
    scope: z.enum(["all", "session"]).optional().default("session"),
    min_age_days: z.number().int().nonnegative().optional().default(7),
    dry_run: z.boolean().optional().default(false),
    use_llm: z
      .boolean()
      .optional()
      .default(false)
      .describe("Use the client's LLM via sampling to produce natural-language summaries. Falls back to heuristic summarization when sampling is unsupported."),
  })
  .strict();

export type ChestConsolidateInput = z.infer<typeof ChestConsolidateInputSchema>;
