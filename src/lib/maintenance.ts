// Opportunistic background maintenance.
//
// Instead of requiring a cron/systemd schedule, maintenance piggybacks on
// writes: after a memory is saved, the executor fires maybeRunMaintenance()
// WITHOUT awaiting it, so saves never wait. The run itself is guarded by
//   1. a throttle (meta.last_maintenance_at, CHEST_MAINTENANCE_INTERVAL_SEC),
//   2. an in-process flag (one run at a time per process),
//   3. the chest-index file lock (never overlaps a manual CLI run or another
//      process — the single-writer principle stays intact).
//
// `chest-index up` remains available as a manual escape hatch and runs the
// exact same phases.

import { prisma, rawGet, rawRun } from "./db/prisma-client.js";
import { acquireLock } from "../cli/chest-index-flock.js";
import { runActivationPhase } from "./activation.js";
import { runDecayPhase } from "./decay.js";
import { runLocalPendingSweep } from "./embedding/sync-embed.js";
import { SWEEP_LIMIT } from "./embedding/config.js";
import { logger } from "../utils/logger.js";
import { validateEnv } from "../utils/env.js";

const META_KEY = "last_maintenance_at";

function intervalSec(): number {
  const raw = Number(process.env.CHEST_MAINTENANCE_INTERVAL_SEC ?? "");
  return Number.isFinite(raw) && raw > 0 ? raw : 600;
}

function autoMaintenanceDisabled(): boolean {
  return process.env.CHEST_AUTO_MAINTENANCE === "0";
}

let runningInProcess = false;

export interface MaintenanceResult {
  ran: boolean;
  reason?: "disabled" | "throttled" | "busy" | "locked" | "error" | "remote-mode";
}

/** Run all maintenance phases now (no throttle). Caller must hold the lock. */
async function runPhases(): Promise<void> {
  await runActivationPhase({});
  await runDecayPhase({});
  const { runSupersessPhase } = await import("./supersession.js");
  const noopEmbed = async (): Promise<number[][]> => [];
  await runSupersessPhase(noopEmbed, {});
  await runLocalPendingSweep(SWEEP_LIMIT);
}

/**
 * Throttled, lock-guarded maintenance pass. Designed to be called WITHOUT
 * await after a write; it never throws.
 */
export async function maybeRunMaintenance(): Promise<MaintenanceResult> {
  // Remote-mode servers MUST NOT run maintenance: embeddings are computed
  // client-side, and acquiring the flock here causes contention with manual
  // `chest-index up` runs from operators. See memory id 5143 and spec
  // FR-048.
  if (validateEnv().CHEST_MODE === "remote") {
    return { ran: false, reason: "remote-mode" };
  }
  if (autoMaintenanceDisabled()) return { ran: false, reason: "disabled" };
  if (runningInProcess) return { ran: false, reason: "busy" };
  runningInProcess = true;
  try {
    const now = Math.floor(Date.now() / 1000);
    const row = await rawGet<{ value: string }>(
      prisma,
      "SELECT value FROM meta WHERE key = ?",
      META_KEY,
    );
    const last = row ? Number(row.value) : 0;
    if (Number.isFinite(last) && now - last < intervalSec()) {
      return { ran: false, reason: "throttled" };
    }

    const lock = acquireLock();
    if (!lock) return { ran: false, reason: "locked" };
    try {
      // Stamp first so a crash mid-run still throttles the next attempt.
      await rawRun(
        prisma,
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        META_KEY,
        String(now),
      );
      const started = Date.now();
      await runPhases();
      logger.info({ ms: Date.now() - started }, "background maintenance complete");
      return { ran: true };
    } finally {
      lock.release();
    }
  } catch (e) {
    logger.warn(
      { err: e instanceof Error ? e.message : String(e) },
      "background maintenance failed (will retry after the interval)",
    );
    return { ran: false, reason: "error" };
  } finally {
    runningInProcess = false;
  }
}
