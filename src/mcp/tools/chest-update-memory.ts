import type { Prisma } from "@prisma/client";
import { prisma, rawGet } from "../../lib/db/prisma-client.js";
import { redactText } from "../../lib/redact.js";
import { MAX_CONTENT_CHARS } from "../../lib/embedding/config.js";
import { CANONICAL_LAYERS, resolveLayer } from "../../schemas/common.js";
import type { ChestUpdateMemoryInput } from "../../schemas/chest-update-memory.js";

interface ExistingMemoryRow {
  id: number;
  entity_id: number;
  layer: string;
  content: string;
  importance: number;
  protected: number;
}

export async function handleChestUpdateMemory(
  args: ChestUpdateMemoryInput,
): Promise<string> {
  const memoryId = args.memory_id;
  const existing = await rawGet<ExistingMemoryRow>(
    prisma,
    "SELECT id, entity_id, layer, content, importance, protected FROM memories WHERE id = ?",
    memoryId,
  );
  if (!existing) {
    return JSON.stringify({ ok: false, error: `memory_id ${memoryId} not found` });
  }

  // Enforce the content cap here as well as in the Zod schema, so direct handler
  // calls (e.g. tests) get the same validation as chest_remember.
  if (typeof args.content === "string" && args.content.length > MAX_CONTENT_CHARS) {
    return JSON.stringify({
      ok: false,
      error:
        `Content too long: ${args.content.length} chars exceeds limit ${MAX_CONTENT_CHARS}. ` +
        `Please split into smaller memories and re-submit.`,
      limit: MAX_CONTENT_CHARS,
      actual: args.content.length,
    });
  }

  // Build the update via the Prisma ORM rather than a string-concatenated SET
  // clause: column names come from the typed model, never from runtime keys, so
  // the previous dynamic-SQL pattern (and any future injection risk) is removed,
  // and a schema rename is a one-line type change instead of editing SQL.
  const data: Prisma.MemoryUpdateInput = {};
  const changed: string[] = [];
  // Credentials are redacted before persistence. The change-detection check for
  // resetting the embedding also uses the redacted value, because the stored
  // content is already redacted — identical redacted values mean no real change.
  const newContent = typeof args.content === "string" ? redactText(args.content) : undefined;
  if (newContent !== undefined) {
    data.content = newContent;
    changed.push("content");
  }
  if (typeof args.layer === "string") {
    const resolved = resolveLayer(args.layer);
    if (!resolved || !(CANONICAL_LAYERS as readonly string[]).includes(resolved)) {
      return JSON.stringify({ ok: false, error: `unknown layer "${args.layer}"` });
    }
    if (existing.layer === "realize" && resolved !== "realize" && existing.protected === 1) {
      return JSON.stringify({
        ok: false,
        error:
          "Cannot move a protected realize memory to another layer. Create a new memory in the target layer instead.",
      });
    }
    data.layer = resolved;
    changed.push("layer");
  }
  let newImportance: number | undefined;
  if (args.importance !== undefined) {
    newImportance = Math.min(1, Math.max(0, args.importance));
    data.importance = newImportance;
    data.protected = newImportance >= 0.9 || existing.protected === 1 ? 1 : 0;
    changed.push("importance", "protected");
  }

  if (changed.length === 0) {
    return JSON.stringify({
      ok: false,
      error: "no fields to update (provide content, layer, or importance)",
    });
  }

  // When content changes, fully reset the embedding pipeline in the same update:
  //   - clear embedding columns (vector, model, dim) to NULL
  //   - reset status to 'pending' so the next indexing cycle re-embeds
  //   - bump state_changed_at for audit purposes
  // If content is unchanged, the embedding columns are left untouched.
  const contentChanged = newContent !== undefined && newContent !== existing.content;
  if (contentChanged) {
    data.embedding = null;
    data.embeddingModel = null;
    data.embeddingStatus = "pending";
    data.embeddingDim = null;
    data.embeddingStateChangedAt = BigInt(Math.floor(Date.now() / 1000));
  }

  await prisma.memory.update({ where: { id: BigInt(memoryId) }, data });

  await prisma.event.create({
    data: {
      entityId: BigInt(existing.entity_id),
      kind: "memory_updated",
      payload: JSON.stringify({ memory_id: memoryId, changed }),
    },
  });

  return JSON.stringify({
    ok: true,
    memory_id: memoryId,
    updated_fields: changed,
    pinned: (newImportance !== undefined ? newImportance : existing.importance) >= 0.9,
  });
}
