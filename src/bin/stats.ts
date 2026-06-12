#!/usr/bin/env node
// chest-memory-stats — summary of the local memory DB.
// Usage:
//   npx chest-memory-stats
//   npx chest-memory-stats --json
//   npx chest-memory-stats --per-entity 10
//
// Safe to run anytime (read-only).
//
// db_size is computed from information_schema.tables.

import { prisma, rawAll, rawGet, ensurePrismaInitialized, shutdownPrisma } from '../lib/db/prisma-client.js';

interface Args {
  json: boolean;
  perEntity: number;
  help: boolean;
}

interface LayerCountRow {
  layer: string;
  c: number;
}

interface KindCountRow {
  kind: string;
  c: number;
}

interface TopEntityRow {
  name: string;
  kind: string;
  momentum_score: number | null;
  memory_count: number;
  last_access: number | null;
}

interface TopFileRow {
  file_path: string;
  edits: number;
  in_sessions: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const a: Args = { json: false, perEntity: 5, help: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--json') a.json = true;
    else if (v === '--per-entity') a.perEntity = Math.max(0, Number(argv[++i] || 5));
    else if (v === '-h' || v === '--help') a.help = true;
  }
  return a;
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function humanDate(unix: number | null | undefined): string {
  if (!unix) return '-';
  return new Date(unix * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

function humanAge(unix: number | null | undefined): string {
  if (!unix) return '-';
  const diff = Math.floor(Date.now() / 1000) - unix;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  return `${Math.floor(diff / 86400 / 30)}mo ago`;
}

function maskedDbTarget(): string {
  const url = process.env.DATABASE_URL ?? '';
  try {
    const u = new URL(url);
    return `mysql://${u.username}:****@${u.host}${u.pathname}`;
  } catch {
    return 'MySQL (DATABASE_URL)';
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (args.help) {
    process.stdout.write(`chest-memory-stats — summary of the local memory DB

  --json             Output machine-readable JSON
  --per-entity N     Show top N entities (default 5, 0 to skip)
  -h, --help         This message
`);
    return;
  }

  await ensurePrismaInitialized();

  const dbPath = maskedDbTarget();
  const sizeRow = await rawGet<{ bytes: number }>(
    prisma,
    'SELECT COALESCE(SUM(data_length + index_length), 0) AS bytes FROM information_schema.tables WHERE table_schema = DATABASE()',
  );
  const sizeBytes = Number(sizeRow?.bytes ?? 0);

  const countOne = async (sql: string): Promise<number> =>
    Number((await rawGet<{ c: number }>(prisma, sql))?.c ?? 0);
  const counts = {
    entities: await countOne('SELECT COUNT(*) as c FROM entities'),
    memories: await countOne('SELECT COUNT(*) as c FROM memories'),
    file_edits: await countOne('SELECT COUNT(*) as c FROM session_file_edits'),
    unique_files: await countOne('SELECT COUNT(DISTINCT file_path) as c FROM session_file_edits'),
    sessions_seen: await countOne('SELECT COUNT(DISTINCT session_id) as c FROM session_file_edits'),
    consolidations: await countOne('SELECT COUNT(*) as c FROM consolidations'),
    events: await countOne('SELECT COUNT(*) as c FROM events'),
  };

  const layerBreakdown = await rawAll<LayerCountRow>(
    prisma,
    'SELECT layer, COUNT(*) as c FROM memories GROUP BY layer ORDER BY c DESC',
  );

  const entityKinds = await rawAll<KindCountRow>(
    prisma,
    'SELECT kind, COUNT(*) as c FROM entities GROUP BY kind ORDER BY c DESC',
  );

  const pinned = await countOne('SELECT COUNT(*) as c FROM memories WHERE importance >= 0.9');
  const protectedCount = await countOne('SELECT COUNT(*) as c FROM memories WHERE protected = 1');

  const oldest = Number(
    (await rawGet<{ t: number | null }>(prisma, 'SELECT MIN(created_at) as t FROM memories'))?.t ?? 0,
  ) || null;
  const newest = Number(
    (await rawGet<{ t: number | null }>(prisma, 'SELECT MAX(created_at) as t FROM memories'))?.t ?? 0,
  ) || null;

  const topEntities: TopEntityRow[] =
    args.perEntity > 0
      ? await rawAll<TopEntityRow>(
          prisma,
          `SELECT e.name, e.kind, e.momentum_score, COUNT(m.id) as memory_count,
                    MAX(m.last_accessed_at) as last_access
             FROM entities e
             LEFT JOIN memories m ON m.entity_id = e.id
             GROUP BY e.id
             ORDER BY memory_count DESC, e.momentum_score DESC
             LIMIT ?`,
          args.perEntity,
        )
      : [];

  const topFiles = await rawAll<TopFileRow>(
    prisma,
    `SELECT file_path, COUNT(*) as edits, COUNT(DISTINCT session_id) as in_sessions
       FROM session_file_edits
       WHERE operation IN ('edit', 'write')
       GROUP BY file_path
       ORDER BY edits DESC
       LIMIT 5`,
  );

  const result = {
    db_path: dbPath,
    db_size: sizeBytes,
    db_size_human: humanBytes(sizeBytes),
    counts,
    pinned,
    realize_protected: protectedCount,
    layer_breakdown: layerBreakdown,
    entity_kinds: entityKinds,
    date_range: {
      oldest: oldest ? new Date(oldest * 1000).toISOString() : null,
      newest: newest ? new Date(newest * 1000).toISOString() : null,
    },
    top_entities: topEntities.map((e) => ({
      name: e.name,
      kind: e.kind,
      momentum: Number((e.momentum_score ?? 0).toFixed(2)),
      memory_count: e.memory_count,
      last_access: e.last_access ? new Date(e.last_access * 1000).toISOString() : null,
    })),
    top_files: topFiles.map((f) => ({
      path: f.file_path,
      edits: f.edits,
      in_sessions: f.in_sessions,
    })),
  };

  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    await shutdownPrisma();
    return;
  }

  // Human-readable output (this is CLI for users, stdout intended)
  const out = process.stdout.write.bind(process.stdout);
  out('\n');
  out('  chest-memory — local brain status\n');
  out('  ' + '═'.repeat(55) + '\n');
  out(`  DB:            ${dbPath}\n`);
  out(`  Size:          ${humanBytes(sizeBytes)}\n`);
  out(`  Oldest memory: ${humanAge(oldest)} (${humanDate(oldest)})\n`);
  out(`  Newest memory: ${humanAge(newest)} (${humanDate(newest)})\n`);
  out('\n');
  out('  Counts\n');
  out(`    entities:       ${counts.entities}\n`);
  out(`    memories:       ${counts.memories}  (${pinned} pinned, ${protectedCount} realize-protected)\n`);
  out(`    file edits:     ${counts.file_edits}  across ${counts.unique_files} unique files\n`);
  out(`    sessions seen:  ${counts.sessions_seen}\n`);
  out(`    consolidations: ${counts.consolidations}\n`);
  out('\n');
  if (layerBreakdown.length > 0) {
    out('  Memories by layer\n');
    for (const r of layerBreakdown) {
      const bar = '█'.repeat(Math.min(40, Math.round((r.c / counts.memories) * 40)));
      out(`    ${r.layer.padEnd(15)} ${String(r.c).padStart(5)}  ${bar}\n`);
    }
    out('\n');
  }
  if (entityKinds.length > 0) {
    out('  Entities by kind\n');
    for (const r of entityKinds) {
      out(`    ${r.kind.padEnd(15)} ${r.c}\n`);
    }
    out('\n');
  }
  if (topEntities.length > 0) {
    out(`  Top ${topEntities.length} entities by memory count\n`);
    for (const e of topEntities) {
      out(
        `    ${String(e.memory_count).padStart(4)}  ${e.name.padEnd(30)} [${e.kind}]  momentum ${Number(e.momentum_score ?? 0).toFixed(1)}  last ${humanAge(e.last_access)}\n`,
      );
    }
    out('\n');
  }
  if (topFiles.length > 0) {
    out('  Top 5 most-edited files\n');
    for (const f of topFiles) {
      const p = f.file_path || '';
      const shortPath = p.length > 65 ? '…' + p.slice(-64) : p;
      out(`    ${String(f.edits).padStart(4)} edits  ${shortPath}\n`);
    }
    out('\n');
  }
  out('  Run with --json for machine-readable output.\n');
  out('\n');

  await shutdownPrisma();
}

main().catch((e) => { console.error(e); process.exit(1); });
