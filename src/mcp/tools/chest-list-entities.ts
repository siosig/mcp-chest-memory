import { prisma, rawAll } from "../../lib/db/prisma-client.js";
import type { ChestListEntitiesInput } from "../../schemas/chest-list-entities.js";
import { instantFromUnixSeconds } from "../../utils/temporal.js";

interface EntityRow {
  id: number;
  name: string;
  kind: string;
  canonical_key: string | null;
  momentum_score: number;
  updated_at: number;
  created_at: number;
  memory_count: number;
  last_memory_access: number | null;
  goal_count: number;
  realize_count: number;
  learning_count: number;
  impl_count: number;
  pinned_count: number;
}

export async function handleChestListEntities(
  args: ChestListEntitiesInput,
): Promise<string> {
  const kind = args.kind;
  const minMemories = Math.max(1, args.min_memories ?? 1);
  const limit = Math.max(1, Math.min(200, args.limit ?? 30));
  const offset = Math.max(0, args.offset ?? 0);

  // GROUP BY on the primary key is safe due to functional dependency on all selected columns.
  // CAST(SUM(CASE...) AS SIGNED) prevents MySQL from returning DECIMAL as a string.
  let sql = `
    SELECT e.id, e.name, e.kind, e.canonical_key, e.momentum_score,
           e.updated_at, e.created_at,
           COUNT(m.id) as memory_count,
           MAX(m.last_accessed_at) as last_memory_access,
           CAST(SUM(CASE WHEN m.layer = 'goal' THEN 1 ELSE 0 END) AS SIGNED) as goal_count,
           CAST(SUM(CASE WHEN m.layer = 'realize' THEN 1 ELSE 0 END) AS SIGNED) as realize_count,
           CAST(SUM(CASE WHEN m.layer = 'learning' THEN 1 ELSE 0 END) AS SIGNED) as learning_count,
           CAST(SUM(CASE WHEN m.layer = 'implementation' THEN 1 ELSE 0 END) AS SIGNED) as impl_count,
           CAST(SUM(CASE WHEN m.importance >= 0.9 THEN 1 ELSE 0 END) AS SIGNED) as pinned_count
    FROM entities e
    LEFT JOIN memories m ON m.entity_id = e.id
    WHERE 1=1
  `;
  const params: unknown[] = [];
  if (kind) {
    sql += " AND e.kind = ?";
    params.push(kind);
  }
  sql += " GROUP BY e.id";
  if (minMemories > 1) {
    sql += " HAVING memory_count >= ?";
    params.push(minMemories);
  }
  sql +=
    " ORDER BY (COALESCE(e.momentum_score,0) * 10 + memory_count * 0.5 + (last_memory_access / 86400.0 / 365) * 2) DESC";
  sql += " LIMIT ? OFFSET ?";
  params.push(limit, offset);

  const rows = await rawAll<EntityRow>(prisma, sql, ...params);

  // Count via the ORM (the ranked SELECT above stays raw — it relies on a
  // computed ORDER BY expression the ORM cannot express).
  const total = await prisma.entity.count(kind ? { where: { kind } } : undefined);

  return JSON.stringify({
    ok: true,
    total,
    returned: rows.length,
    offset,
    has_more: offset + rows.length < total,
    entities: rows.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      canonical_key: r.canonical_key,
      momentum: Number((r.momentum_score ?? 0).toFixed(2)),
      memory_count: r.memory_count,
      last_memory_access: r.last_memory_access ? instantFromUnixSeconds(r.last_memory_access) : null,
      layer_breakdown: {
        goal: r.goal_count,
        realize: r.realize_count,
        learning: r.learning_count,
        implementation: r.impl_count,
      },
      pinned_count: r.pinned_count,
    })),
  });
}
