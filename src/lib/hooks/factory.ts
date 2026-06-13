import { recallRemote } from "../hooks-remote.js";
import { DefaultPromptTextStrategy } from "./prompt-classifier.js";
import type { UserPromptSubmitRunnerOptions } from "./user-prompt-submit-runner.js";

export function createUserPromptSubmitRunnerOptions(): UserPromptSubmitRunnerOptions {
  return {
    promptStrategy: new DefaultPromptTextStrategy(),
    remoteClient: { recallRemote },
  };
}
