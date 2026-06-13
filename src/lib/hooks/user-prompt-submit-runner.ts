import { mkdirSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Temporal } from "../../utils/temporal.js";
import { UserPromptSubmitPayloadSchema } from "../../schemas/user-prompt-submit.js";
import type { HookRecalledMemory } from "../../schemas/hook-recall.js";
import { projectNameFromCwd } from "../session-parser.js";
import { DefaultPromptTextStrategy } from "./prompt-classifier.js";
import type { PromptTextStrategy } from "./prompt-text-strategy.js";
import { formatRecallContext } from "./recall-context-formatter.js";

export interface RemoteRecallClient {
  recallRemote(
    query: string,
    opts?: { project?: string; layers?: string[]; limit?: number; max_tokens?: number; signal?: AbortSignal },
  ): Promise<HookRecalledMemory[]>;
}

export interface UserPromptSubmitRunnerOptions {
  promptStrategy?: PromptTextStrategy;
  remoteClient: RemoteRecallClient;
  timeoutMs?: number;
  limit?: number;
  maxTokens?: number;
  log?: (message: string) => void;
}

const DEFAULT_TIMEOUT_MS = 2500;
const DEFAULT_LIMIT = 8;
const DEFAULT_MAX_TOKENS = 1500;

function nowIso(): string {
  return Temporal.Now.instant().toString();
}

export function appendHookLog(component: string, message: string): void {
  const logDir = process.env.CHEST_DATA_DIR ?? join(homedir(), ".chest-memory");
  const logFile = join(logDir, "hook.log");
  try {
    mkdirSync(logDir, { recursive: true, mode: 0o700 });
    appendFileSync(logFile, `[${nowIso()}] [${component}] ${message}\n`, { mode: 0o600 });
  } catch {
    /* hook logging must never throw */
  }
}

export async function runUserPromptSubmit(rawStdin: string, options: UserPromptSubmitRunnerOptions): Promise<string> {
  const startedAt = Temporal.Now.instant().epochMilliseconds;
  const log = options.log ?? ((message: string): void => appendHookLog("user-prompt-submit", message));
  let payload: unknown;
  try {
    payload = rawStdin.trim() ? JSON.parse(rawStdin) : {};
  } catch (error: unknown) {
    log(`stdin parse error: ${error instanceof Error ? error.message : String(error)}`);
    return "";
  }

  const parsed = UserPromptSubmitPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    log("payload validation skipped");
    return "";
  }

  const prompt = parsed.data.prompt ?? "";
  const strategy = options.promptStrategy ?? new DefaultPromptTextStrategy();
  const classification = strategy.classify(prompt);
  if (!classification.shouldRecall) return "";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const cwd = parsed.data.cwd ?? "";
    const project = projectNameFromCwd(cwd);
    const memories = await options.remoteClient.recallRemote(classification.query, {
      project,
      layers: ["realize", "learning"],
      limit: options.limit ?? DEFAULT_LIMIT,
      max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
      signal: controller.signal,
    });
    const elapsedMs = Temporal.Now.instant().epochMilliseconds - startedAt;
    if (memories.length > 0) log(`remote recall injected count=${memories.length} elapsed_ms=${elapsedMs}`);
    return formatRecallContext(memories);
  } catch (error: unknown) {
    const elapsedMs = Temporal.Now.instant().epochMilliseconds - startedAt;
    log(`remote recall skipped elapsed_ms=${elapsedMs} error=${error instanceof Error ? error.message : String(error)}`);
    return "";
  } finally {
    clearTimeout(timeout);
  }
}
