import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { prisma, rawAll, rawGet } from "../../lib/db/prisma-client.js";
import { escapeLike, LIKE_ESCAPE } from "../../lib/db/sql-escape.js";
import type { ChestRecallFileInput } from "../../schemas/chest-recall-file.js";
import { fetchRoots, isInsideRoots } from "../roots.js";
import { instantFromUnixSeconds } from "../../utils/temporal.js";

interface RecallFileSummaryRow {
  c: number;
  first_at: number | null;
  last_at: number | null;
  sessions: number;
}

interface RecallFileDailyRow {
  day: string;
  operation: string;
  edits: number;
}

interface RecallFileIntentRow {
  context_snippet: string;
  last_at: number;
  freq: number;
}

interface RecallFileLinkedMemoryRow {
  id: number;
  layer: string;
  content: string;
  importance: number;
  entity_name: string;
}

interface RecallFilePathRow {
  file_path: string;
  edits: number;
}

interface RecallFileBaseResponse {
  ok: true;
  path_substring: string;
  paths_matched: RecallFilePathRow[];
  summary: {
    total_edits: number;
    first_edit_at: string;
    last_edit_at: string;
    sessions_involved: number;
  };
  daily_breakdown: RecallFileDailyRow[];
  user_intents: Array<{ when: string; occurrences: number; intent: string }>;
  linked_memories: Array<{
    id: number;
    entity: string;
    layer: string;
    importance: number;
    preview: string;
  }>;
  roots_filter?: {
    applied: boolean;
    reason?: string;
    root_count?: number;
    before?: number;
    after?: number;
  };
}

// Uses CHAR_LENGTH (character-count semantics) and DATE_FORMAT(FROM_UNIXTIME(...)) for MySQL compatibility.
// GROUP BY on the primary key is safe because entity id is functionally dependent on all selected columns.
async function baseRecallFile(args: ChestRecallFileInput): Promise<string> {
  const sub = args.path_substring.trim();
  if (!sub) return JSON.stringify({ ok: false, error: "path_substring required" });
  const maxIntents = Math.max(1, Math.min(50, args.max_intents ?? 10));
  // Escape LIKE wildcards so a path_substring of "%" matches literally instead
  // of every file. Bound as `?`; the ESCAPE clause declares the backslash.
  const likePat = `%${escapeLike(sub)}%`;

  const totalRow = await rawGet<RecallFileSummaryRow>(
    prisma,
    `SELECT COUNT(*) as c, MIN(occurred_at) as first_at, MAX(occurred_at) as last_at, COUNT(DISTINCT session_id) as sessions FROM session_file_edits WHERE file_path LIKE ? ${LIKE_ESCAPE}`,
    likePat,
  );
  if (!totalRow || totalRow.c === 0) {
    return JSON.stringify({
      ok: true,
      count: 0,
      note: "No edits found for that path substring.",
    });
  }

  const daily = await rawAll<RecallFileDailyRow>(
    prisma,
    `SELECT DATE_FORMAT(FROM_UNIXTIME(occurred_at), '%Y-%m-%d') as day, operation, COUNT(*) as edits
       FROM session_file_edits WHERE file_path LIKE ? ${LIKE_ESCAPE}
       GROUP BY day, operation ORDER BY day`,
    likePat,
  );

  const intents = await rawAll<RecallFileIntentRow>(
    prisma,
    `SELECT context_snippet, MAX(occurred_at) as last_at, COUNT(*) as freq
       FROM session_file_edits
       WHERE file_path LIKE ? ${LIKE_ESCAPE} AND context_snippet IS NOT NULL AND CHAR_LENGTH(context_snippet) > 20
       GROUP BY context_snippet
       ORDER BY last_at DESC
       LIMIT ?`,
    likePat,
    maxIntents,
  );

  const memories = await rawAll<RecallFileLinkedMemoryRow>(
    prisma,
    `SELECT DISTINCT m.id, m.layer, m.content, m.importance, e.name as entity_name
       FROM session_file_edits sfe
       JOIN memories m ON m.id = sfe.memory_id
       JOIN entities e ON e.id = m.entity_id
       WHERE sfe.file_path LIKE ? ${LIKE_ESCAPE}
       ORDER BY m.importance DESC
       LIMIT 20`,
    likePat,
  );

  const paths = await rawAll<RecallFilePathRow>(
    prisma,
    `SELECT file_path, COUNT(*) as edits FROM session_file_edits WHERE file_path LIKE ? ${LIKE_ESCAPE} GROUP BY file_path ORDER BY edits DESC`,
    likePat,
  );

  const response: RecallFileBaseResponse = {
    ok: true,
    path_substring: sub,
    paths_matched: paths,
    summary: {
      total_edits: totalRow.c,
      first_edit_at: instantFromUnixSeconds(totalRow.first_at ?? 0),
      last_edit_at: instantFromUnixSeconds(totalRow.last_at ?? 0),
      sessions_involved: totalRow.sessions,
    },
    daily_breakdown: daily,
    user_intents: intents.map((i) => ({
      when: instantFromUnixSeconds(i.last_at),
      occurrences: i.freq,
      intent: i.context_snippet,
    })),
    linked_memories: memories.map((m) => ({
      id: m.id,
      entity: m.entity_name,
      layer: m.layer,
      importance: m.importance,
      preview: m.content.length > 300 ? m.content.slice(0, 300) + "..." : m.content,
    })),
  };
  return JSON.stringify(response);
}

export async function handleChestRecallFile(
  args: ChestRecallFileInput,
  lowLevelServer: Server,
): Promise<string> {
  const baseJson = await baseRecallFile(args);
  if (!args.scope_to_roots) return baseJson;
  let parsed: RecallFileBaseResponse | { ok: false; error?: string; count?: number };
  try {
    parsed = JSON.parse(baseJson);
  } catch {
    return baseJson;
  }
  if (!parsed || !("ok" in parsed) || !parsed.ok || !("paths_matched" in parsed)) return baseJson;
  const responseWithRoots = parsed as RecallFileBaseResponse;
  const roots = await fetchRoots(lowLevelServer);
  if (roots.length === 0) {
    responseWithRoots.roots_filter = { applied: false, reason: "client provided no roots" };
    return JSON.stringify(responseWithRoots);
  }
  const filtered = responseWithRoots.paths_matched.filter((p) => isInsideRoots(p.file_path, roots));
  responseWithRoots.roots_filter = {
    applied: true,
    root_count: roots.length,
    before: responseWithRoots.paths_matched.length,
    after: filtered.length,
  };
  responseWithRoots.paths_matched = filtered;
  return JSON.stringify(responseWithRoots);
}
