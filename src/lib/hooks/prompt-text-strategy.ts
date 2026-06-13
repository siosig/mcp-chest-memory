export interface PromptClassification {
  shouldRecall: boolean;
  query: string;
  reason: "meaningful" | "empty" | "too_short" | "acknowledgement" | "meta";
}

/** Strategy boundary for turning a raw user prompt into a recall query. */
export interface PromptTextStrategy {
  classify(prompt: string): PromptClassification;
}
