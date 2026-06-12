import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { prisma, rawAll, rawGet, rawRun } from "../../lib/db/prisma-client.js";
import { consolidate as runConsolidate } from "../../lib/consolidate.js";
import type { ChestConsolidateInput } from "../../schemas/chest-consolidate.js";
import { sampleConsolidation } from "../sampling.js";

interface DryRunCandidateRow {
  entity_id: number;
  entity_name: string;
  layer: string;
  c: number;
}

interface SnapshotRow {
  id: number;
  content: string;
  entity_name: string;
}

interface ConsolidationsAuditRow {
  replaced_ids: string;
}

interface ConsolidateRunResult {
  ok: boolean;
  scanned: number;
  clustersCompressed: number;
  memoriesReplaced: number;
  memoriesDropped: number;
  learningIdsCreated: number[];
  sampling?: {
    applied: boolean;
    upgraded?: number;
    declined?: number;
    reason?: string;
    decline_reasons?: string[];
  };
}

async function dryRunConsolidate(args: ChestConsolidateInput): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const ageCutoff = now - (args.min_age_days ?? 7) * 86400;
  // GROUP BY on entity_id is safe due to functional dependency. COUNT(*) returns bigint; callers numify to number.
  const candidates = await rawAll<DryRunCandidateRow>(
    prisma,
    `
    SELECT m.entity_id, e.name as entity_name, m.layer, COUNT(*) as c
    FROM memories m
    JOIN entities e ON e.id = m.entity_id
    WHERE m.protected = 0
      AND m.importance < 0.9
      AND m.layer IN ('context', 'emotion', 'implementation')
      AND m.created_at <= ?
    GROUP BY m.entity_id, m.layer
    HAVING c >= 2
    ORDER BY c DESC
  `,
    ageCutoff,
  );
  const totalReplaced = candidates.reduce((s, c) => s + c.c, 0);
  return JSON.stringify({
    ok: true,
    dry_run: true,
    clusters: candidates.length,
    memories_replaced_if_run: totalReplaced,
    preview: candidates.slice(0, 20).map((c) => ({
      entity: c.entity_name,
      layer: c.layer,
      count: c.c,
    })),
    hint: "Set dry_run=false to actually consolidate.",
  });
}

export async function handleChestConsolidate(
  args: ChestConsolidateInput,
  lowLevelServer: Server,
): Promise<string> {
  if (args.dry_run) {
    return dryRunConsolidate(args);
  }

  if (!args.use_llm) {
    const result = await runConsolidate({
      scope: args.scope,
      min_age_days: args.min_age_days,
    });
    return JSON.stringify({ ok: true, ...result });
  }

  const ageCutoff = Math.floor(Date.now() / 1000) - (args.min_age_days ?? 7) * 86400;
  const snapshot = new Map<number, SnapshotRow>();
  const candidateRows = await rawAll<SnapshotRow>(
    prisma,
    `SELECT m.id, m.content, e.name as entity_name
       FROM memories m JOIN entities e ON e.id = m.entity_id
       WHERE m.protected = 0
         AND m.layer IN ('context','emotion','implementation')
         AND m.created_at <= ?`,
    ageCutoff,
  );
  for (const r of candidateRows) snapshot.set(r.id, r);

  const baseResult = await runConsolidate({
    scope: args.scope,
    min_age_days: args.min_age_days,
  });
  const parsed: ConsolidateRunResult = { ok: true, ...baseResult };

  if (!Array.isArray(parsed.learningIdsCreated) || parsed.learningIdsCreated.length === 0) {
    parsed.sampling = { applied: false, reason: "consolidate returned no learning entries" };
    return JSON.stringify(parsed);
  }

  let upgraded = 0;
  let declined = 0;
  const declineReasons: string[] = [];
  for (const learningId of parsed.learningIdsCreated) {
    const audit = await rawGet<ConsolidationsAuditRow>(
      prisma,
      "SELECT replaced_ids FROM consolidations WHERE learning_id = ?",
      learningId,
    );
    if (!audit) {
      declined++;
      continue;
    }
    let replaced: number[];
    try {
      replaced = JSON.parse(audit.replaced_ids) as number[];
    } catch {
      declined++;
      continue;
    }
    if (!Array.isArray(replaced) || replaced.length < 2) {
      declined++;
      continue;
    }
    const sources = replaced
      .map((id) => snapshot.get(id))
      .filter((s): s is SnapshotRow => Boolean(s));
    if (sources.length < 2) {
      declined++;
      continue;
    }
    const entityName = sources[0]?.entity_name ?? "<entity>";
    const result = await sampleConsolidation(
      lowLevelServer,
      sources.map((s) => s.content),
      entityName,
    );
    if (result.ok && result.text) {
      await rawRun(prisma, "UPDATE memories SET content = ? WHERE id = ?", result.text.trim(), learningId);
      upgraded++;
    } else {
      declined++;
      if (result.reason && declineReasons.length < 3) declineReasons.push(result.reason);
    }
  }
  parsed.sampling = {
    applied: true,
    upgraded,
    declined,
    ...(declineReasons.length ? { decline_reasons: declineReasons } : {}),
  };
  return JSON.stringify(parsed);
}
