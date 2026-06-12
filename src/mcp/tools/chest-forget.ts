import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { prisma, rawAll, rawGet } from "../../lib/db/prisma-client.js";
import { computeHeat } from "../../lib/heat-index.js";
import { decideForgetting } from "../../lib/forgetting.js";
import { archiveMemory, archiveMemories } from "../../lib/archive.js";
import type { ChestForgetInput } from "../../schemas/chest-forget.js";
import { confirmForget } from "../elicitation.js";

interface ForgetCandidateRow {
  id: number;
  layer: string;
  importance: number;
  access_count: number;
  last_accessed_at: number;
  protected: number;
}

interface ForgetTargetRow {
  id: number;
  layer: string;
  importance: number;
  protected: number;
}

interface ForgetInteractivePreviewRow {
  id: number;
  layer: string;
  content: string;
  importance: number;
  entity: string;
}

export async function handleChestForget(
  args: ChestForgetInput,
  lowLevelServer: Server,
): Promise<string> {
  if (args.memory_id !== undefined) {
    const target = await rawGet<ForgetTargetRow>(
      prisma,
      "SELECT id, layer, importance, protected FROM memories WHERE id = ?",
      args.memory_id,
    );
    if (!target) {
      return JSON.stringify({ ok: false, error: `memory_id ${args.memory_id} not found` });
    }
    if (target.protected === 1 || target.importance >= 0.9) {
      const isLayerProtected = target.protected === 1;
      return JSON.stringify({
        ok: false,
        preserved: true,
        reason: isLayerProtected ? `${target.layer}-layer is auto-protected` : "pinned (importance>=0.9)",
        hint: isLayerProtected
          ? `${target.layer} memories are permanently protected (the whole point — pain lessons must not be lost). If you truly need to delete, copy its content to another layer via chest_remember() first, then drop the DB row manually via a SQLite client.`
          : "Use chest_update_memory to lower importance below 0.9 first, then chest_forget.",
      });
    }

    // dry_run: preview the archive candidate without mutating state.
    if (args.dry_run) {
      return JSON.stringify({
        ok: true,
        dry_run: true,
        would_archive: args.memory_id,
        memory_id: args.memory_id,
      });
    }

    if (args.interactive) {
      const row = await rawGet<ForgetInteractivePreviewRow>(
        prisma,
        `SELECT m.id, m.layer, m.content, m.importance, e.name as entity FROM memories m JOIN entities e ON e.id = m.entity_id WHERE m.id = ?`,
        args.memory_id,
      );
      if (!row) return JSON.stringify({ ok: false, error: `memory ${args.memory_id} not found` });
      const ok = await confirmForget(lowLevelServer, {
        id: row.id,
        entity: row.entity,
        layer: row.layer,
        importance: row.importance,
        preview: row.content,
      });
      if (!ok) {
        return JSON.stringify({
          ok: false,
          declined: true,
          memory_id: args.memory_id,
          reason: "user declined elicitation",
        });
      }
    }

    // Archive-first: never physically DELETE. Idempotent via archive.ts.
    const archived = await archiveMemory(args.memory_id, "forget");
    return JSON.stringify({ ok: true, archived: archived ? 1 : 0, memory_id: args.memory_id });
  }

  const rows = await rawAll<ForgetCandidateRow>(
    prisma,
    `SELECT id, layer, importance, access_count, last_accessed_at, protected
       FROM memories
       WHERE protected = 0 AND importance < 0.9`,
  );

  const now = Math.floor(Date.now() / 1000);
  const actions: Array<{ id: number; action: "keep" | "compress" | "drop" }> = [];

  for (const r of rows) {
    const daysSince = (now - r.last_accessed_at) / 86400;
    const heat = computeHeat({
      accessesLast30d: daysSince < 30 ? r.access_count : 0,
      accessesLast90d: daysSince < 90 ? r.access_count : 0,
      daysSinceLastAccess: daysSince,
      totalAccesses: r.access_count,
      baseImportance: r.importance,
    });
    const action = decideForgetting({
      daysSinceLastAccess: daysSince,
      importance: r.importance,
      heatScore: heat.score,
      protected: r.protected === 1,
      layer: r.layer,
    });
    if (action !== "keep") actions.push({ id: r.id, action });
  }

  const toDropIds = actions.filter((a) => a.action === "drop").map((a) => a.id);

  // Sweep drops become archive transitions (no physical DELETE).
  if (!args.dry_run) {
    await archiveMemories(toDropIds, "dropped");
  }

  return JSON.stringify({
    ok: true,
    dry_run: !!args.dry_run,
    scanned: rows.length,
    to_drop: toDropIds.length,
    to_compress: actions.filter((a) => a.action === "compress").length,
    sample_ids_to_drop: toDropIds.slice(0, 10),
  });
}
