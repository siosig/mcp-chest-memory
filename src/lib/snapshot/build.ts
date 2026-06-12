// Priority-tiered working-state snapshot builder. Pure function — no DB or I/O.
//
// Tiers (higher = kept longer under budget pressure):
//   tier 1: Active files          — always preserved
//   tier 2: Unresolved errors     — always preserved (realize-layer memories for this session)
//   tier 3: Goals                 — always preserved
//   tier 4: Recent decisions      — dropped first when budget is tight
//
// Budget: 2048 bytes (UTF-8). Tiers are dropped whole from lowest to highest priority,
// except tiers 1–2 which are only row-trimmed, never dropped entirely.

export interface SnapshotMemoryItem {
  content: string;
  importance: number;
}

export interface SnapshotInput {
  sessionId: string;
  fileEdits: { filePath: string; opCount: number }[];
  realizes: SnapshotMemoryItem[];
  goals: SnapshotMemoryItem[];
  learnings: SnapshotMemoryItem[];
}

export const SNAPSHOT_BUDGET_BYTES = 2048;

/** Maximum code points per item. Keeps even long realize entries to their key point. */
const ITEM_MAX_CP = 160;
/** Maximum items per tier, independent of byte budget (noise prevention). */
const MAX_FILES = 10;
const MAX_ITEMS_PER_TIER = 5;

function clip(text: string, maxCp: number): string {
  const cps = Array.from(text.replace(/\s+/g, " ").trim());
  if (cps.length <= maxCp) return cps.join("");
  return cps.slice(0, maxCp).join("") + "…";
}

function byteLen(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

interface Tier {
  heading: string;
  lines: string[];
  /** When true, the tier is never dropped wholesale under budget pressure — only row-trimmed. */
  protected: boolean;
}

function renderTiers(tiers: Tier[]): string {
  const parts: string[] = ["## Working state (restored by chest-memory)"];
  for (const t of tiers) {
    if (t.lines.length === 0) continue;
    parts.push(`### ${t.heading}`);
    parts.push(...t.lines);
  }
  return parts.join("\n");
}

/**
 * Build the snapshot text. Returns an empty string when there is nothing to
 * snapshot (no file edits and no memories), in which case the caller should skip
 * persisting the snapshot.
 */
export function buildSnapshot(
  input: SnapshotInput,
  budgetBytes: number = SNAPSHOT_BUDGET_BYTES,
): string {
  const sortByImp = (items: SnapshotMemoryItem[]) =>
    [...items].sort((a, b) => b.importance - a.importance).slice(0, MAX_ITEMS_PER_TIER);

  const tiers: Tier[] = [
    {
      heading: "Active files",
      protected: true,
      lines: [...input.fileEdits]
        .sort((a, b) => b.opCount - a.opCount)
        .slice(0, MAX_FILES)
        .map((f) => `- ${f.filePath} (${f.opCount} edits)`),
    },
    {
      heading: "Unresolved errors",
      protected: true,
      lines: sortByImp(input.realizes).map((m) => `- ${clip(m.content, ITEM_MAX_CP)}`),
    },
    {
      heading: "Goals",
      protected: true,
      lines: sortByImp(input.goals).map((m) => `- ${clip(m.content, ITEM_MAX_CP)}`),
    },
    {
      heading: "Recent decisions",
      protected: false,
      lines: sortByImp(input.learnings).map((m) => `- ${clip(m.content, ITEM_MAX_CP)}`),
    },
  ];

  if (tiers.every((t) => t.lines.length === 0)) return "";

  // Drop lowest-priority unprotected tiers wholesale (reverse order) until budget is met.
  // Protected tiers are never dropped here; row-trimming below handles them.
  let text = renderTiers(tiers);
  for (let i = tiers.length - 1; i >= 0 && byteLen(text) > budgetBytes; i--) {
    if (tiers[i].protected) continue;
    tiers[i].lines = [];
    text = renderTiers(tiers);
  }

  // Still over budget: trim rows from protected tiers one at a time from lowest priority
  // (Goals first), keeping at least 1 row in Active files and Unresolved errors.
  while (byteLen(text) > budgetBytes) {
    const target = [...tiers]
      .reverse()
      .find((t) => t.lines.length > (t.heading === "Active files" || t.heading === "Unresolved errors" ? 1 : 0));
    if (!target) break; // Cannot trim further — budget overrun at this point is negligible
    target.lines.pop();
    text = renderTiers(tiers);
  }

  return text;
}
