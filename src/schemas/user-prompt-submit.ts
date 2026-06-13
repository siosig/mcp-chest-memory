import { z } from "zod";

export const UserPromptSubmitPayloadSchema = z
  .object({
    session_id: z.string().optional(),
    prompt: z.string().optional(),
    cwd: z.string().optional(),
  })
  .passthrough();

export type UserPromptSubmitPayload = z.infer<typeof UserPromptSubmitPayloadSchema>;
