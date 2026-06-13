// Bridge: after a remote chest_remember call returns memory_id, compute the
// embedding client-side (bge-m3 in-process) and push it back through
// POST /memories/:id/embedding so the row never lingers in pending.
//
// This module is the integration point between the MCP stdio process and the
// REST backend's reliability-bundle endpoints. It is a no-op when:
//   - the server reports server_has_embedder=true (local-mode backend), or
//   - CHEST_CLIENT_EMBED resolves to false, or
//   - the bridge cannot be initialized (missing remote URL / token).
//
// Failures here MUST NOT fail the chest_remember call — the row is already
// safely persisted with embedding_status='pending' and the background sweep
// (manual `chest-index pending-resync`) will pick it up. We only log a
// stderr line guiding the user toward `chest-index fetch-model`.

import { createHash } from "node:crypto";
import { CapabilitiesClient } from "../http/client.js";
import { embedTextClient, isModelCacheMissing } from "../lib/embedding/client-embed.js";
import { activeProvider } from "../lib/embedding/provider.js";
import { clientEmbedEnabled, validateEnv } from "../utils/env.js";
import { logger } from "../utils/logger.js";

let capabilitiesClient: CapabilitiesClient | undefined;
let bridgeDisabled = false;
let missingModelWarned = false;

function getClient(): CapabilitiesClient | undefined {
  if (bridgeDisabled) return undefined;
  if (capabilitiesClient) return capabilitiesClient;
  const env = validateEnv();
  if (env.CHEST_MODE !== "remote") {
    bridgeDisabled = true;
    return undefined;
  }
  if (!clientEmbedEnabled(env)) {
    bridgeDisabled = true;
    return undefined;
  }
  if (!env.CHEST_REMOTE_URL || !env.CHEST_API_TOKEN) {
    bridgeDisabled = true;
    return undefined;
  }
  capabilitiesClient = new CapabilitiesClient({
    baseUrl: env.CHEST_REMOTE_URL,
    token: env.CHEST_API_TOKEN,
  });
  return capabilitiesClient;
}

interface RememberResultLike {
  ok?: boolean;
  memory_id?: number;
}

function parseMemoryId(resultText: string): number | undefined {
  try {
    const parsed = JSON.parse(resultText) as RememberResultLike;
    if (parsed.ok && typeof parsed.memory_id === "number") return parsed.memory_id;
  } catch {
    /* not a JSON envelope — nothing to do */
  }
  return undefined;
}

function sha1Hex(text: string): string {
  return createHash("sha1").update(text, "utf8").digest("hex");
}

/**
 * After a successful chest_remember call, embed the content locally and push
 * the vector via POST /memories/:id/embedding. Best-effort: silently no-ops
 * outside remote/client-embed mode, and fail-soft on any error.
 */
export async function maybePushClientEmbedding(
  resultText: string,
  content: string,
): Promise<void> {
  const client = getClient();
  if (!client) return;

  let caps;
  try {
    caps = await client.getCapabilities();
  } catch (e) {
    // Capability lookup failed; do not block the write. Resync CLI will recover.
    logger.warn(
      { err: e instanceof Error ? e.message : String(e) },
      "client-embed bridge: capabilities lookup failed",
    );
    return;
  }
  if (caps.server_has_embedder) return; // server will embed; nothing to do

  const memoryId = parseMemoryId(resultText);
  if (!memoryId) return;

  const embed = await embedTextClient(content);
  if (!(embed instanceof Float32Array)) {
    if (isModelCacheMissing(embed) && !missingModelWarned) {
      missingModelWarned = true;
      process.stderr.write(
        "[chest-memory] embedding model not cached locally. Run: chest-index fetch-model\n",
      );
    }
    return;
  }

  const provider = activeProvider();
  try {
    await client.updateEmbedding(
      memoryId,
      Array.from(embed),
      provider.model,
      sha1Hex(content),
    );
  } catch (e) {
    logger.warn(
      { err: e instanceof Error ? e.message : String(e), memoryId },
      "client-embed bridge: updateEmbedding failed (row stays pending)",
    );
  }
}

/** Test helper: reset memoized state. */
export function resetClientEmbedBridgeForTest(): void {
  capabilitiesClient = undefined;
  bridgeDisabled = false;
  missingModelWarned = false;
}
