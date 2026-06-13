import { isMetaOrNoise } from "../session-parser.js";
import type { PromptClassification, PromptTextStrategy } from "./prompt-text-strategy.js";

const MAX_QUERY_CHARS = 2000;
const MIN_MEANINGFUL_CHARS = 4;
const ACKNOWLEDGEMENTS = new Set([
  "y",
  "yes",
  "ok",
  "okay",
  "continue",
  "next",
  "go on",
  "proceed",
  "done",
  "はい",
  "うん",
  "了解",
  "続けて",
  "次へ",
  "okです",
  "お願いします",
]);

function normalizePrompt(prompt: string): string {
  return prompt.replace(/\s+/g, " ").trim();
}

export class DefaultPromptTextStrategy implements PromptTextStrategy {
  classify(prompt: string): PromptClassification {
    const normalized = normalizePrompt(prompt);
    if (!normalized) return { shouldRecall: false, query: "", reason: "empty" };
    if (isMetaOrNoise(normalized)) return { shouldRecall: false, query: "", reason: "meta" };
    const lower = normalized.toLowerCase();
    if (ACKNOWLEDGEMENTS.has(lower)) return { shouldRecall: false, query: "", reason: "acknowledgement" };
    if (Array.from(normalized).length < MIN_MEANINGFUL_CHARS) {
      return { shouldRecall: false, query: "", reason: "too_short" };
    }
    return {
      shouldRecall: true,
      query: Array.from(normalized).slice(0, MAX_QUERY_CHARS).join(""),
      reason: "meaningful",
    };
  }
}
