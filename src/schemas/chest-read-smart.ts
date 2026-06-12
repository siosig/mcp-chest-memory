import { z } from "zod";

export const ChestReadSmartInputSchema = z
  .object({
    path: z.string().min(1).describe("Absolute file path"),
    force: z.boolean().optional().default(false),
  })
  .strict();

export type ChestReadSmartInput = z.infer<typeof ChestReadSmartInputSchema>;
