#!/usr/bin/env node
import "../utils/temporal.js";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { ensurePrismaInitialized, shutdownPrisma } from "../lib/db/prisma-client.js";
import { validateEnv } from "../utils/env.js";
import { guardStdoutAgainstConsoleLog, logger } from "../utils/logger.js";
import { handleError } from "../utils/errors.js";

import { ChestRememberInputSchema } from "../schemas/chest-remember.js";
import { ChestRecallInputSchema } from "../schemas/chest-recall.js";
import { ChestUpdateMemoryInputSchema } from "../schemas/chest-update-memory.js";
import { ChestListEntitiesInputSchema } from "../schemas/chest-list-entities.js";
import { ChestForgetInputSchema } from "../schemas/chest-forget.js";
import { ChestConsolidateInputSchema } from "../schemas/chest-consolidate.js";
import { ChestRecallFileInputSchema } from "../schemas/chest-recall-file.js";
import { ChestReadSmartInputSchema } from "../schemas/chest-read-smart.js";

import { LocalExecutor, type ToolExecutor } from "../core/executor.js";
import { RemoteExecutor } from "../http/client.js";
import { handleReadSmart } from "./read-smart.js";
import { LocalSnapshotStore, type SnapshotStore } from "./snapshot-store.js";
import { RemoteSnapshotStore } from "./snapshot-store-remote.js";

import { registerChestResources } from "./resources.js";
import { registerChestPrompts } from "./prompts.js";
import { maybePushClientEmbedding } from "./client-embed-bridge.js";

const SERVER_VERSION = "1.0.0";

guardStdoutAgainstConsoleLog();
const env = validateEnv();

// Local mode opens the SQLite store in-process; remote mode never touches a
// local database — every tool call is forwarded to the REST backend.
if (env.CHEST_MODE === "local") {
  try {
    await ensurePrismaInitialized();
  } catch (err: unknown) {
    process.stderr.write(`[chest-memory] DB init failed: ${(err as Error).message}\n`);
    process.exit(1);
  }
}

const mcpServer = new McpServer({
  name: "chest-memory",
  version: SERVER_VERSION,
});

let executor: ToolExecutor;
// chest_read_smart is the only tool that reads a client-side file, so it always
// runs in this process (where the file and the client roots exist) regardless of
// profile; only its snapshot cache is persisted through this store. Picking the
// store here — the composition root — mirrors picking the executor, so no
// deployment branch ever enters the read_smart logic itself.
let snapshotStore: SnapshotStore;
if (env.CHEST_MODE === "remote") {
  if (!env.CHEST_REMOTE_URL || !env.CHEST_API_TOKEN) {
    process.stderr.write(
      "[chest-memory] CHEST_MODE=remote requires CHEST_REMOTE_URL and CHEST_API_TOKEN\n",
    );
    process.exit(1);
  }
  executor = new RemoteExecutor({ baseUrl: env.CHEST_REMOTE_URL, token: env.CHEST_API_TOKEN });
  snapshotStore = new RemoteSnapshotStore(executor);
} else {
  executor = new LocalExecutor(mcpServer.server);
  snapshotStore = new LocalSnapshotStore();
}

function wrapResult(jsonText: string) {
  return { content: [{ type: "text" as const, text: jsonText }] };
}

function wrapError(error: unknown) {
  const payload = handleError(error);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    isError: true,
  };
}

mcpServer.registerTool(
  "chest_remember",
  {
    title: "chest: Save persistent memory",
    description:
      'Save context that should persist across sessions. Use when the user says "remember this" / "don\'t forget", or when you discover a decision, preference, or lesson worth preserving. The server auto-organizes into layers (goal/context/emotion/implementation/realize/learning) and manages lifecycle. Supports Japanese and English.',
    inputSchema: ChestRememberInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async (params) => {
    try {
      const resultText = await executor.execute("chest_remember", params);
      // Remote+client-embed mode: compute the vector locally and push it back
      // so the row never lingers in embedding_status='pending'. Fail-soft.
      const content = typeof (params as { content?: unknown }).content === "string"
        ? (params as { content: string }).content
        : "";
      if (content) {
        void maybePushClientEmbedding(resultText, content).catch(() => {
          /* logged inside the bridge */
        });
      }
      return wrapResult(resultText);
    } catch (err: unknown) {
      return wrapError(err);
    }
  },
);

mcpServer.registerTool(
  "chest_recall",
  {
    title: "chest: Recall persistent memories",
    description:
      'Recall persistent memories. When the user asks about past decisions, context, or preferences, call this first. Returns memories ranked by relevance and recency. Works in Japanese and English. Use at the start of any task that might involve prior work.',
    inputSchema: ChestRecallInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params) => {
    try {
      return wrapResult(await executor.execute("chest_recall", params));
    } catch (err: unknown) {
      return wrapError(err);
    }
  },
);

mcpServer.registerTool(
  "chest_update_memory",
  {
    title: "chest: Update an existing memory",
    description:
      "Atomically edit an existing memory in-place. Preferred over forget+remember because it preserves memory_id, which matters for session_file_edits links and referential integrity. Use to correct facts, update deadlines in goal entries, refine realizes, or re-score importance. Realize-layer memories can be updated but cannot have their protected flag removed.",
    inputSchema: ChestUpdateMemoryInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params) => {
    try {
      return wrapResult(await executor.execute("chest_update_memory", params));
    } catch (err: unknown) {
      return wrapError(err);
    }
  },
);

mcpServer.registerTool(
  "chest_list_entities",
  {
    title: "chest: List entities by activity",
    description:
      'List the entities currently known to this memory store, sorted by recent activity. Use at the start of a new session ("what do I know about?") before issuing specific chest_recall queries. Cheaper than chest_recall for the "give me an overview" question.',
    inputSchema: ChestListEntitiesInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params) => {
    try {
      return wrapResult(await executor.execute("chest_list_entities", params));
    } catch (err: unknown) {
      return wrapError(err);
    }
  },
);

mcpServer.registerTool(
  "chest_forget",
  {
    title: "chest: Delete a memory (with realize protection)",
    description:
      "Explicitly delete a memory by id, OR run auto-forgetting across all memories based on forgettingRisk (importance + heat + age). Realize-layer, goal-layer, and pinned (importance>=0.9) memories are always preserved. Prefer chest_update_memory for corrections — chest_forget is destructive.",
    inputSchema: ChestForgetInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async (params) => {
    try {
      return wrapResult(await executor.execute("chest_forget", params));
    } catch (err: unknown) {
      return wrapError(err);
    }
  },
);

mcpServer.registerTool(
  "chest_consolidate",
  {
    title: "chest: Compress cold memories into learning summaries",
    description:
      "Sleep-mode compression. Clusters cold low-importance memories by (entity, layer), summarizes each cluster into a single protected learning-layer entry, deletes originals, and runs a forget-sweep. Run at session end or on demand. Set dry_run=true to preview without writing.",
    inputSchema: ChestConsolidateInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async (params) => {
    try {
      return wrapResult(await executor.execute("chest_consolidate", params));
    } catch (err: unknown) {
      return wrapError(err);
    }
  },
);

mcpServer.registerTool(
  "chest_recall_file",
  {
    title: "chest: File edit history across sessions",
    description:
      "Get the COMPLETE edit history of a file across all sessions, with per-edit user-intent context. Returns: total edit count, daily breakdown, list of distinct user intents that drove the edits, and the linked memories. Use this when you need to understand WHY a file was modified historically — far more accurate than chest_recall() for file-centric questions because it queries session_file_edits (every physical edit) instead of summary memories.",
    inputSchema: ChestRecallFileInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params) => {
    try {
      return wrapResult(await executor.execute("chest_recall_file", params));
    } catch (err: unknown) {
      return wrapError(err);
    }
  },
);

mcpServer.registerTool(
  "chest_read_smart",
  {
    title: "chest: Diff-cached file read",
    description:
      'Read a file with diff-only caching. Returns: (1) full content + chunk metadata on first read, (2) "unchanged" + cached chunk list (~50 tokens) if mtime matches, (3) "unchanged_content" if mtime changed but sha256 matches (touched but not modified), (4) changed chunks with content + unchanged chunks as metadata-only if the file was truly modified. Use INSTEAD of Read for files you have read before — saves 50%+ tokens on re-reads.',
    inputSchema: ChestReadSmartInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async (params) => {
    try {
      const input = ChestReadSmartInputSchema.parse(params);
      return wrapResult(await handleReadSmart(input, mcpServer.server, snapshotStore));
    } catch (err: unknown) {
      return wrapError(err);
    }
  },
);

registerChestResources(mcpServer);
registerChestPrompts(mcpServer);

const transport = new StdioServerTransport();
await mcpServer.connect(transport);
logger.info({ version: SERVER_VERSION, mode: env.CHEST_MODE }, "chest-memory MCP server ready on stdio");
process.stderr.write(`[chest-memory] MCP server ready on stdio (v${SERVER_VERSION})\n`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void shutdownPrisma().finally(() => process.exit(0));
  });
}
