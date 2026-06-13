import type { HookRecalledMemory } from "../../src/schemas/hook-recall.js";

export function hookMemory(overrides: Partial<HookRecalledMemory> = {}): HookRecalledMemory {
  return {
    id: 1,
    layer: "learning",
    title: "mcp-chest-memory / learning",
    content: "Prefer the shared recall service for hook recall.",
    importance: 0.8,
    score: 0.91,
    project: "mcp-chest-memory",
    created_at: "2026-06-13T00:00:00Z",
    ...overrides,
  };
}
