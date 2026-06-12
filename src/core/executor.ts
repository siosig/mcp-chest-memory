// Tool execution port — the single switch point between deployment profiles.
//
// The MCP stdio server and the REST backend both dispatch through a
// ToolExecutor. In local mode the LocalExecutor runs the in-process logic
// against SQLite; in remote mode the MCP server swaps in a RemoteExecutor
// (src/http/client.ts) that forwards the identical payload to the backend.
// Tool semantics therefore never diverge between profiles.

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

import { ChestRememberInputSchema } from "../schemas/chest-remember.js";
import { ChestRecallInputSchema } from "../schemas/chest-recall.js";
import { ChestUpdateMemoryInputSchema } from "../schemas/chest-update-memory.js";
import { ChestListEntitiesInputSchema } from "../schemas/chest-list-entities.js";
import { ChestForgetInputSchema } from "../schemas/chest-forget.js";
import { ChestConsolidateInputSchema } from "../schemas/chest-consolidate.js";
import { ChestRecallFileInputSchema } from "../schemas/chest-recall-file.js";
import { ChestReadSmartInputSchema } from "../schemas/chest-read-smart.js";

import { handleChestRemember } from "../mcp/tools/chest-remember.js";
import { handleChestRecall } from "../mcp/tools/chest-recall.js";
import { handleChestUpdateMemory } from "../mcp/tools/chest-update-memory.js";
import { handleChestListEntities } from "../mcp/tools/chest-list-entities.js";
import { handleChestForget } from "../mcp/tools/chest-forget.js";
import { handleChestConsolidate } from "../mcp/tools/chest-consolidate.js";
import { handleChestRecallFile } from "../mcp/tools/chest-recall-file.js";
import { handleChestReadSmart } from "../mcp/tools/chest-read-smart.js";
import { embedMemorySync } from "../lib/embedding/sync-embed.js";
import { maybeRunMaintenance } from "../lib/maintenance.js";

export const TOOL_NAMES = [
  "chest_remember",
  "chest_recall",
  "chest_update_memory",
  "chest_list_entities",
  "chest_forget",
  "chest_consolidate",
  "chest_recall_file",
  "chest_read_smart",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export function isToolName(name: string): name is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(name);
}

export interface ToolExecutor {
  /** Execute one tool call; the result is the tool's JSON string payload. */
  execute(name: ToolName, args: unknown): Promise<string>;
}

// With the local provider, freshly written memories are embedded in-process
// right after the write so vector recall works immediately. Failures are
// silent by contract: the row stays pending and the sweep catches up later.
async function syncEmbedFromResult(
  resultJson: string,
  content: string,
  fallbackId?: number,
): Promise<void> {
  try {
    const parsed = JSON.parse(resultJson) as { ok?: boolean; memory_id?: number | string };
    if (parsed.ok !== true) return;
    const id = parsed.memory_id !== undefined ? Number(parsed.memory_id) : fallbackId;
    if (!id || Number.isNaN(id)) return;
    await embedMemorySync(id, content);
  } catch {
    /* never let embedding interfere with the tool result */
  }
}

// Some handlers can ask the connected MCP client for extras (elicitation,
// sampling, roots). In the REST backend there is no client; this stub makes
// every such request fail, which the helpers already translate into their
// graceful fallbacks ("unsupported" / empty roots).
const noClientServer = {
  request: async () => {
    throw new Error("no MCP client attached (REST backend context)");
  },
} as unknown as Server;

/** Runs tools in-process against the local SQLite store. */
export class LocalExecutor implements ToolExecutor {
  private readonly server: Server;

  constructor(server?: Server) {
    this.server = server ?? noClientServer;
  }

  async execute(name: ToolName, args: unknown): Promise<string> {
    switch (name) {
      case "chest_remember": {
        const input = ChestRememberInputSchema.parse(args);
        const out = await handleChestRemember(input);
        await syncEmbedFromResult(out, input.content);
        // Maintenance (decay, supersession, archive sweeps) rides on writes
        // instead of a scheduler. Deliberately not awaited: the save returns
        // immediately; the pass is throttled and lock-guarded internally.
        void maybeRunMaintenance();
        return out;
      }
      case "chest_recall":
        return handleChestRecall(ChestRecallInputSchema.parse(args));
      case "chest_update_memory": {
        const input = ChestUpdateMemoryInputSchema.parse(args);
        const out = await handleChestUpdateMemory(input);
        if (input.content !== undefined) {
          await syncEmbedFromResult(out, input.content, input.memory_id);
        }
        return out;
      }
      case "chest_list_entities":
        return handleChestListEntities(ChestListEntitiesInputSchema.parse(args));
      case "chest_forget":
        return handleChestForget(ChestForgetInputSchema.parse(args), this.server);
      case "chest_consolidate":
        return handleChestConsolidate(ChestConsolidateInputSchema.parse(args), this.server);
      case "chest_recall_file":
        return handleChestRecallFile(ChestRecallFileInputSchema.parse(args), this.server);
      case "chest_read_smart":
        return handleChestReadSmart(ChestReadSmartInputSchema.parse(args), this.server);
    }
  }
}
