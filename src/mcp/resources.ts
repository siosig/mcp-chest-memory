import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { prisma, rawAll, rawGet } from "../lib/db/prisma-client.js";
import { instantFromUnixSeconds } from "../utils/temporal.js";

interface MemoryRow {
  id: number;
  layer: string;
  content: string;
  importance: number;
  protected: number;
  created_at: number | null;
  last_accessed_at: number | null;
  access_count: number;
  entity_name: string;
  entity_kind: string;
}

interface LayerCountRow {
  layer: string;
  c: number;
}

interface KindCountRow {
  kind: string;
  c: number;
}

const VALID_LAYERS = new Set([
  "goal",
  "context",
  "emotion",
  "implementation",
  "realize",
  "learning",
]);

const SELECT_MEMORY_BASE = `
  SELECT m.id, m.layer, m.content, m.importance, m.protected, m.created_at, m.last_accessed_at, m.access_count,
         e.name as entity_name, e.kind as entity_kind
  FROM memories m JOIN entities e ON e.id = m.entity_id
`;

function fmtMemory(row: MemoryRow): Record<string, unknown> {
  return {
    id: row.id,
    entity: row.entity_name,
    entity_kind: row.entity_kind,
    layer: row.layer,
    importance: row.importance,
    pinned: row.protected === 1 || row.importance >= 0.9,
    content: row.content,
    created_at: row.created_at ? instantFromUnixSeconds(row.created_at) : null,
    last_accessed_at: row.last_accessed_at ? instantFromUnixSeconds(row.last_accessed_at) : null,
    access_count: row.access_count,
  };
}

function jsonResource(uri: string, payload: unknown): {
  contents: Array<{ uri: string; mimeType: string; text: string }>;
} {
  return {
    contents: [
      {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

async function readStats(uri: string) {
  const entityCount = Number(
    (await rawGet<{ c: number }>(prisma, "SELECT COUNT(*) as c FROM entities"))?.c ?? 0,
  );
  const memCount = Number(
    (await rawGet<{ c: number }>(prisma, "SELECT COUNT(*) as c FROM memories"))?.c ?? 0,
  );
  const byLayer = await rawAll<LayerCountRow>(
    prisma,
    "SELECT layer, COUNT(*) as c FROM memories GROUP BY layer",
  );
  const byKind = await rawAll<KindCountRow>(
    prisma,
    "SELECT kind, COUNT(*) as c FROM entities GROUP BY kind",
  );
  const pinned = Number(
    (await rawGet<{ c: number }>(
      prisma,
      "SELECT COUNT(*) as c FROM memories WHERE importance >= 0.9 OR protected = 1",
    ))?.c ?? 0,
  );
  return jsonResource(uri, {
    entity_count: entityCount,
    memory_count: memCount,
    pinned_count: pinned,
    by_layer: Object.fromEntries(byLayer.map((r) => [r.layer, r.c])),
    by_entity_kind: Object.fromEntries(byKind.map((r) => [r.kind, r.c])),
  });
}

async function readHot(uri: string) {
  const rows = await rawAll<MemoryRow>(
    prisma,
    `${SELECT_MEMORY_BASE}
       WHERE m.last_accessed_at IS NOT NULL
       ORDER BY m.access_count DESC, m.last_accessed_at DESC
       LIMIT 50`,
  );
  return jsonResource(uri, {
    count: rows.length,
    note: 'Approximation by access_count + last_accessed_at. Use the chest_recall tool with band="hot" for exact heat scoring.',
    memories: rows.map(fmtMemory),
  });
}

async function readRecent(uri: string) {
  const cutoff = Math.floor(Date.now() / 1000) - 7 * 24 * 3600;
  const rows = await rawAll<MemoryRow>(
    prisma,
    `${SELECT_MEMORY_BASE} WHERE m.last_accessed_at >= ? ORDER BY m.last_accessed_at DESC LIMIT 50`,
    cutoff,
  );
  return jsonResource(uri, { count: rows.length, memories: rows.map(fmtMemory) });
}

async function readRealizes(uri: string) {
  const rows = await rawAll<MemoryRow>(
    prisma,
    `${SELECT_MEMORY_BASE} WHERE m.layer = 'realize' ORDER BY m.importance DESC, m.created_at DESC`,
  );
  return jsonResource(uri, { count: rows.length, memories: rows.map(fmtMemory) });
}

async function readEntity(uri: string, name: string) {
  const rows = await rawAll<MemoryRow>(
    prisma,
    `${SELECT_MEMORY_BASE} WHERE LOWER(e.name) = LOWER(?) ORDER BY m.importance DESC, m.created_at DESC`,
    name,
  );
  return jsonResource(uri, { entity: name, count: rows.length, memories: rows.map(fmtMemory) });
}

async function readLayer(uri: string, layer: string) {
  const lower = layer.toLowerCase();
  if (!VALID_LAYERS.has(lower)) {
    throw new Error(
      `unknown layer "${layer}". Known: goal, context, emotion, implementation, realize, learning`,
    );
  }
  const rows = await rawAll<MemoryRow>(
    prisma,
    `${SELECT_MEMORY_BASE} WHERE m.layer = ? ORDER BY m.importance DESC, m.created_at DESC LIMIT 200`,
    lower,
  );
  return jsonResource(uri, { layer: lower, count: rows.length, memories: rows.map(fmtMemory) });
}

async function readMemoryById(uri: string, id: number) {
  const row = await rawGet<MemoryRow>(prisma, `${SELECT_MEMORY_BASE} WHERE m.id = ?`, id);
  if (!row) throw new Error(`memory id ${id} not found`);
  return jsonResource(uri, fmtMemory(row));
}

export function registerChestResources(mcpServer: McpServer): void {
  mcpServer.registerResource(
    "memory-stats",
    "memory://stats",
    {
      title: "Memory store statistics",
      description: "Summary counts: entities, memories, layer breakdown, heat distribution.",
      mimeType: "application/json",
    },
    async (uri) => readStats(uri.href),
  );

  mcpServer.registerResource(
    "memory-hot",
    "memory://hot",
    {
      title: "Hot memories",
      description: 'Memories currently in the "hot" heat band — what the agent is actively working with.',
      mimeType: "application/json",
    },
    async (uri) => readHot(uri.href),
  );

  mcpServer.registerResource(
    "memory-recent",
    "memory://recent",
    {
      title: "Recently accessed memories",
      description: "Memories accessed in the last 7 days, ordered by recency.",
      mimeType: "application/json",
    },
    async (uri) => readRecent(uri.href),
  );

  mcpServer.registerResource(
    "memory-realizes",
    "memory://realizes",
    {
      title: "All realizes",
      description: 'Every realize-layer memory — the protected "never forget" pile of pain lessons.',
      mimeType: "application/json",
    },
    async (uri) => readRealizes(uri.href),
  );

  mcpServer.registerResource(
    "memory-entity",
    new ResourceTemplate("memory://entity/{name}", { list: undefined }),
    {
      title: "Memories for an entity",
      description:
        "All memories about a specific entity (person/company/project/concept/file). Replace {name} with the entity name.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const nameVar = variables["name"];
      const name = Array.isArray(nameVar) ? nameVar[0] : nameVar;
      return readEntity(uri.href, decodeURIComponent(String(name ?? "")));
    },
  );

  mcpServer.registerResource(
    "memory-layer",
    new ResourceTemplate("memory://layer/{layer}", { list: undefined }),
    {
      title: "Memories in a layer",
      description:
        "All memories in a specific layer. Replace {layer} with one of: goal, context, emotion, implementation, realize, learning.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const layerVar = variables["layer"];
      const layer = Array.isArray(layerVar) ? layerVar[0] : layerVar;
      return readLayer(uri.href, decodeURIComponent(String(layer ?? "")));
    },
  );

  mcpServer.registerResource(
    "memory-by-id",
    new ResourceTemplate("memory://memory/{id}", { list: undefined }),
    {
      title: "A single memory",
      description: "Read a single memory by its numeric id. Replace {id} with the memory_id.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const idVar = variables["id"];
      const id = Number(Array.isArray(idVar) ? idVar[0] : idVar);
      if (!Number.isFinite(id)) throw new Error(`Invalid memory id: ${String(idVar)}`);
      return readMemoryById(uri.href, id);
    },
  );
}
