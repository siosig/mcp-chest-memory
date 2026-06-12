import { z } from "zod";

export const EntityKindSchema = z.enum([
  "person",
  "company",
  "project",
  "concept",
  "file",
  "other",
]);
export type EntityKind = z.infer<typeof EntityKindSchema>;

export const CANONICAL_LAYERS = [
  "goal",
  "context",
  "emotion",
  "implementation",
  "realize",
  "learning",
] as const;

export const CanonicalLayerSchema = z.enum(CANONICAL_LAYERS);
export type CanonicalLayer = z.infer<typeof CanonicalLayerSchema>;

export const HeatBandSchema = z.enum(["hot", "warm", "cold", "frozen"]);
export type HeatBand = z.infer<typeof HeatBandSchema>;

export const MomentumBandSchema = z.enum(["surging", "active", "quiet", "dormant"]);
export type MomentumBand = z.infer<typeof MomentumBandSchema>;

export const LayerInputSchema = z
  .string()
  .min(1)
  .describe(
    "Canonical: goal/context/emotion/implementation/realize/learning. Aliases (decisions/warnings/how/why etc.) accepted.",
  );

export const ImportanceSchema = z
  .number()
  .min(0)
  .max(1)
  .describe("0.0-1.0. Values >= 0.9 pin the memory (survives forget sweeps even outside the realize layer).");

export const LAYER_ALIASES: Record<string, CanonicalLayer> = {
  goal: "goal",
  context: "context",
  emotion: "emotion",
  implementation: "implementation",
  realize: "realize",
  learning: "learning",
  why: "goal",
  goals: "goal",
  target: "goal",
  targets: "goal",
  intent: "goal",
  background: "context",
  reason: "context",
  situation: "context",
  timing: "context",
  tone: "emotion",
  feelings: "emotion",
  mood: "emotion",
  impl: "implementation",
  success: "implementation",
  failure: "implementation",
  how: "implementation",
  tried: "implementation",
  attempts: "implementation",
  warning: "realize",
  warnings: "realize",
  pain: "realize",
  rule: "realize",
  rules: "realize",
  pitfall: "realize",
  pitfalls: "realize",
  dont: "realize",
  decision: "learning",
  decisions: "learning",
  learned: "learning",
  insight: "learning",
  insights: "learning",
  growth: "learning",
};

export function resolveLayer(input: string | undefined): CanonicalLayer | undefined {
  if (!input) return undefined;
  const key = input.toLowerCase().trim();
  return LAYER_ALIASES[key];
}
