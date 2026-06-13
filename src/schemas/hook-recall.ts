import { z } from "zod";
import { CanonicalLayerSchema } from "./common.js";

export const DEFAULT_HOOK_RECALL_LAYERS = ["realize", "learning"] as const;
export const DEFAULT_HOOK_RECALL_LIMIT = 8;
export const DEFAULT_HOOK_RECALL_MAX_TOKENS = 1500;
export const MAX_HOOK_RECALL_LIMIT = 20;
export const MAX_HOOK_RECALL_TOKENS = 3000;

export const HookRecallRequestSchema = z
  .object({
    query: z.string().trim().min(1).max(8000),
    project: z.string().trim().min(1).max(200).optional(),
    layers: z.array(CanonicalLayerSchema).min(1).max(6).optional(),
    limit: z.number().int().positive().max(200).optional(),
    max_tokens: z.number().int().positive().max(10000).optional(),
  })
  .strict();

export type HookRecallRequestInput = z.input<typeof HookRecallRequestSchema>;
export type HookRecallRequest = z.infer<typeof HookRecallRequestSchema>;

export interface NormalizedHookRecallRequest {
  query: string;
  project?: string;
  layers: string[];
  limit: number;
  max_tokens: number;
}

export const HookRecalledMemorySchema = z
  .object({
    id: z.number().int().positive(),
    layer: z.string(),
    title: z.string(),
    content: z.string(),
    importance: z.number(),
    score: z.number(),
    project: z.string(),
    created_at: z.string(),
  })
  .strict();

export const HookRecallResponseSchema = z
  .object({
    ok: z.literal(true),
    notice: z.string().optional(),
    memories: z.array(HookRecalledMemorySchema),
  })
  .strict();

export type HookRecalledMemory = z.infer<typeof HookRecalledMemorySchema>;
export type HookRecallResponse = z.infer<typeof HookRecallResponseSchema>;

export function normalizeHookRecallRequest(input: HookRecallRequest): NormalizedHookRecallRequest {
  return {
    query: input.query,
    ...(input.project ? { project: input.project } : {}),
    layers: input.layers ?? [...DEFAULT_HOOK_RECALL_LAYERS],
    limit: Math.min(input.limit ?? DEFAULT_HOOK_RECALL_LIMIT, MAX_HOOK_RECALL_LIMIT),
    max_tokens: Math.min(input.max_tokens ?? DEFAULT_HOOK_RECALL_MAX_TOKENS, MAX_HOOK_RECALL_TOKENS),
  };
}
