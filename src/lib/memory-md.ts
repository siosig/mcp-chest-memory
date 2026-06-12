// Parse Claude Code auto-memory markdown files (~/.claude/projects/<dir>/memory/*.md).
// These files are curated, distilled memories with a small frontmatter block:
//
//   ---
//   name: short-slug-or-title
//   description: one-line summary
//   type: user | feedback | project | reference     (flat form), or
//   metadata:
//     type: user | feedback | project | reference   (nested form)
//   originSessionId: <uuid>                          (optional)
//   ---
//   <body>
//
// No YAML library is used: only the handful of keys above are needed, so a
// line-based parser keeps the dependency surface flat.

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface ParsedMemoryFile {
  name: string;
  description: string;
  type: string | null;
  originSessionId: string | null;
  body: string;
}

export interface MemoryLayerMapping {
  layer: string;
  importance: number;
}

const MEMORY_INDEX_FILE = 'MEMORY.md';

// Frontmatter `type` → chest layer/importance. Curated memories rank above
// the 0.5 default of heuristic session extraction; `feedback` (user guidance
// and corrections) is the most valuable and lands in the learning layer.
const TYPE_MAPPING: Record<string, MemoryLayerMapping> = {
  feedback: { layer: 'learning', importance: 0.7 },
  user: { layer: 'context', importance: 0.6 },
  project: { layer: 'context', importance: 0.6 },
  reference: { layer: 'context', importance: 0.6 },
};

const DEFAULT_MAPPING: MemoryLayerMapping = { layer: 'context', importance: 0.5 };

export function mapMemoryType(type: string | null): MemoryLayerMapping {
  if (!type) return DEFAULT_MAPPING;
  return TYPE_MAPPING[type.toLowerCase()] ?? DEFAULT_MAPPING;
}

function stripQuotes(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

function nameFromFileName(fileName: string): string {
  return fileName.replace(/\.md$/i, '');
}

// Returns null when the file has no usable content (empty body and no description).
export function parseMemoryMarkdown(raw: string, fileName: string): ParsedMemoryFile | null {
  const lines = raw.split(/\r?\n/);
  let name = '';
  let description = '';
  let type: string | null = null;
  let originSessionId: string | null = null;
  let bodyStart = 0;

  if (lines[0]?.trim() === '---') {
    let end = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') { end = i; break; }
    }
    if (end > 0) {
      bodyStart = end + 1;
      let inMetadata = false;
      for (let i = 1; i < end; i++) {
        const line = lines[i];
        if (!line.trim()) continue;
        const indented = /^\s/.test(line);
        const m = line.match(/^\s*([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
        if (!m) continue;
        const key = m[1];
        const value = stripQuotes(m[2]);
        if (!indented) {
          inMetadata = key === 'metadata';
          if (inMetadata) continue;
          if (key === 'name') name = value;
          else if (key === 'description') description = value;
          else if (key === 'type') type = value || null;
          else if (key === 'originSessionId') originSessionId = value || null;
        } else if (inMetadata && key === 'type') {
          type = value || null;
        }
      }
    }
  }

  const body = lines.slice(bodyStart).join('\n').trim();
  if (!body && !description) return null;

  return {
    name: name || nameFromFileName(fileName),
    description,
    type,
    originSessionId,
    body,
  };
}

// Compose the memory content stored in the DB: title + summary + body,
// truncated to fit the embedding content limit.
export function buildMemoryContent(parsed: ParsedMemoryFile, maxChars: number): string {
  const parts = [`# ${parsed.name}`];
  if (parsed.description) parts.push(parsed.description);
  if (parsed.body) parts.push('', parsed.body);
  const content = parts.join('\n').trim();
  return content.length > maxChars ? content.slice(0, maxChars) : content;
}

// List importable memory markdown files for a project dir.
// MEMORY.md is an index duplicating each file's description, so it is skipped
// whenever individual memory files exist; it is imported only as a fallback
// when it is the sole file (older format with inline content).
export function collectMemoryFiles(projectDir: string): string[] {
  const memoryDir = join(projectDir, 'memory');
  let entries: string[];
  try {
    entries = readdirSync(memoryDir)
      .filter((f) => f.toLowerCase().endsWith('.md'))
      .filter((f) => {
        try { return statSync(join(memoryDir, f)).isFile(); } catch { return false; }
      })
      .sort();
  } catch {
    return [];
  }
  const individual = entries.filter((f) => f !== MEMORY_INDEX_FILE);
  const selected = individual.length > 0 ? individual : entries;
  return selected.map((f) => join(memoryDir, f));
}
