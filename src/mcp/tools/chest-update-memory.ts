import { prisma, rawGet, rawRun } from "../../lib/db/prisma-client.js";
import { redactText } from "../../lib/redact.js";
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

  const patch: Record<string, string | number> = {};
  // Credentials are redacted before persistence.
  // The change-detection check for resetting the embedding also uses the redacted value,
  // because the stored content is already redacted — identical redacted values mean no real change.
  const newContent = typeof args.content === "string" ? redactText(args.content) : undefined;
  if (newContent !== undefined) patch["content"] = newContent;
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
    patch["layer"] = resolved;
  }
  if (args.importance !== undefined) {
    const imp = Math.min(1, Math.max(0, args.importance));
    patch["importance"] = imp;
    patch["protected"] = imp >= 0.9 || existing.protected === 1 ? 1 : 0;
  }

  const keys = Object.keys(patch);
  if (keys.length === 0) {
    return JSON.stringify({
      ok: false,
      error: "no fields to update (provide content, layer, or importance)",
    });
  }
  const setClause = keys.map((k) => `${k} = ?`).join(", ");
  const values = keys.map((k) => patch[k]);
  await rawRun(prisma, `UPDATE memories SET ${setClause} WHERE id = ?`, ...values, memoryId);

  // When content changes, fully reset the embedding pipeline:
  //   - clear embedding columns (vector, model, dim, batch_id) to NULL
  //   - reset status to 'pending' so the next indexing cycle re-embeds
  //   - reset error info and transient retry counter (new content = fresh attempt)
  //   - update state_changed_at for audit purposes
  // If content is not provided or is identical to the stored value, the embedding columns are left untouched.
  if (newContent !== undefined && newContent !== existing.content) {
    const nowSec = Math.floor(Date.now() / 1000);
    await rawRun(
      prisma,
      `UPDATE memories SET
         embedding = NULL,
         embedding_model = NULL,
         embedding_status = 'pending',
         embedding_batch_id = NULL,
         embedding_dim = NULL,
         embedding_error_kind = NULL,
         embedding_error_reason = NULL,
         embedding_transient_retry_count = 0,
         embedding_state_changed_at = ?
       WHERE id = ?`,
      nowSec,
      memoryId,
    );
  }

  await rawRun(
    prisma,
    "INSERT INTO events (entity_id, kind, payload) VALUES (?, ?, ?)",
    existing.entity_id,
    "memory_updated",
    JSON.stringify({ memory_id: memoryId, changed: keys }),
  );

  return JSON.stringify({
    ok: true,
    memory_id: memoryId,
    updated_fields: keys,
    pinned: (typeof patch["importance"] === "number" ? patch["importance"] : existing.importance) >= 0.9,
  });
}
