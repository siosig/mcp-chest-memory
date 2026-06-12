import { prisma, rawGet, rawRun, lastInsertId } from "../../lib/db/prisma-client.js";
import { refreshMomentumForEntity } from "../../lib/momentum.js";
import { normalizeEntityName } from "../../lib/normalize.js";
import { isPastedExternalContent } from "../../lib/session-parser.js";
import { CANONICAL_LAYERS, resolveLayer } from "../../schemas/common.js";
import { defaultExpiresAt } from "../../lib/activation.js";
import { supersede } from "../../lib/supersession.js";
import { MAX_CONTENT_CHARS } from "../../lib/embedding/config.js";
import { redactText } from "../../lib/redact.js";
import type { ChestRememberInput } from "../../schemas/chest-remember.js";

interface UpsertEntityArgs {
  name: string;
  kind: string;
  key?: string;
}

interface EntityIdRow {
  id: number;
}

export async function upsertEntity(args: UpsertEntityArgs): Promise<number> {
  if (args.key) {
    const byKey = await rawGet<EntityIdRow>(
      prisma,
      "SELECT id FROM entities WHERE canonical_key = ?",
      args.key,
    );
    if (byKey) return byKey.id;
  }

  const normalized = normalizeEntityName(args.name);
  const byNorm = await rawGet<EntityIdRow>(
    prisma,
    "SELECT id FROM entities WHERE kind = ? AND normalized_name = ?",
    args.kind,
    normalized,
  );
  if (byNorm) {
    if (args.key) {
      await rawRun(
        prisma,
        "UPDATE entities SET canonical_key = ?, updated_at = unixepoch() WHERE id = ? AND canonical_key IS NULL",
        args.key,
        byNorm.id,
      );
    }
    return byNorm.id;
  }

  const byName = await rawGet<EntityIdRow>(
    prisma,
    "SELECT id FROM entities WHERE kind = ? AND LOWER(name) = LOWER(?)",
    args.kind,
    args.name,
  );
  if (byName) {
    await rawRun(
      prisma,
      "UPDATE entities SET normalized_name = ?, updated_at = unixepoch() WHERE id = ? AND normalized_name IS NULL",
      normalized,
      byName.id,
    );
    if (args.key) {
      await rawRun(
        prisma,
        "UPDATE entities SET canonical_key = ?, updated_at = unixepoch() WHERE id = ? AND canonical_key IS NULL",
        args.key,
        byName.id,
      );
    }
    return byName.id;
  }

  await rawRun(
    prisma,
    "INSERT INTO entities (kind, name, normalized_name, canonical_key) VALUES (?, ?, ?, ?)",
    args.kind,
    args.name,
    normalized,
    args.key ?? null,
  );
  return lastInsertId(prisma);
}

export async function handleChestRemember(args: ChestRememberInput): Promise<string> {
  const layer = resolveLayer(args.layer);
  if (!layer || !(CANONICAL_LAYERS as readonly string[]).includes(layer)) {
    return JSON.stringify({
      ok: false,
      error: `unknown layer "${args.layer}". Known: ${CANONICAL_LAYERS.join(", ")} (aliases: decisions, warnings, how, why, ...)`,
    });
  }

  const rawContent = args.content;

  // Enforce the content length limit here as well as in the Zod schema,
  // so that direct handler calls (e.g. tests) get the same validation behavior.
  if (rawContent.length > MAX_CONTENT_CHARS) {
    return JSON.stringify({
      ok: false,
      error:
        `Content too long: ${rawContent.length} chars exceeds limit ${MAX_CONTENT_CHARS}. ` +
        `Please split into smaller memories and re-submit.`,
      limit: MAX_CONTENT_CHARS,
      actual: rawContent.length,
    });
  }

  if (!args.force && isPastedExternalContent(rawContent)) {
    return JSON.stringify({
      ok: false,
      rejected: "quality_check",
      reason:
        "Content looks like pasted assistant output, CI log, or external paste. Pass force:true if this really is original thought worth keeping.",
      hint: "If you meant to save an extracted insight from that paste, summarize it in your own words first.",
    });
  }

  const entityId = await upsertEntity({
    name: args.entity_name,
    kind: args.entity_kind,
    key: args.entity_key,
  });
  const importance = Math.min(1, Math.max(0, args.importance ?? 0.5));

  // Explicit expires_at wins; otherwise use the layer-default TTL.
  const nowSec = Math.floor(Date.now() / 1000);
  const expiresAt = args.expires_at ?? defaultExpiresAt(layer, nowSec);

  // realize-layer memories are always protected by a DB trigger.
  // Non-realize memories are pinned when importance >= 0.9.
  // embedding_status is explicitly set to 'pending' rather than relying on
  // the column default, so every code path — including direct handler calls —
  // is consistent.
  // Credentials are redacted immediately before persistence; quality checks
  // (length / paste detection) run on the original unredacted text above.
  await rawRun(
    prisma,
    `INSERT INTO memories
       (entity_id, layer, content, importance, protected, expires_at,
        embedding_status, embedding_state_changed_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
    entityId,
    layer,
    redactText(rawContent),
    importance,
    importance >= 0.9 ? 1 : 0,
    expiresAt,
    nowSec,
  );
  const newId = await lastInsertId(prisma);

  await prisma.event.create({
    data: {
      entityId: BigInt(entityId),
      kind: "memory_stored",
      payload: JSON.stringify({ layer, memory_id: newId }),
    },
  });

  // Explicit supersedes: archive the named older memories immediately (method=manual).
  // Protected/pinned/goal targets are never archived — a supersedes list must not
  // be a way to silently destroy protected memory. Skipped ids are reported back.
  const superseded: number[] = [];
  const skippedProtected: number[] = [];
  if (args.supersedes && args.supersedes.length > 0) {
    for (const oldId of args.supersedes) {
      if (oldId === newId) continue;
      const target = await prisma.memory.findFirst({
        where: { id: BigInt(oldId), archivedAt: null },
        select: { protected: true, importance: true, layer: true },
      });
      if (target && (target.protected === 1 || target.importance >= 0.9 || target.layer === "goal")) {
        skippedProtected.push(oldId);
        continue;
      }
      if (await supersede(oldId, newId, null, "manual", nowSec)) {
        superseded.push(oldId);
      }
    }
  }

  const mom = await refreshMomentumForEntity(entityId);

  return JSON.stringify({
    ok: true,
    memory_id: newId,
    entity_id: entityId,
    layer,
    pinned: importance >= 0.9,
    momentum: { score: mom.score, band: mom.band },
    ...(superseded.length > 0 ? { superseded } : {}),
    ...(skippedProtected.length > 0 ? { skipped_protected: skippedProtected } : {}),
  });
}
