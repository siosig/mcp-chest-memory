#!/usr/bin/env node
// chest-index — unified maintenance CLI for chest-memory.
//
// Heavy computation (ACT-R activation, archive sweep, supersession sweep,
// embedding backfill) runs here, outside the MCP server, typically from a
// periodic scheduler (cron / systemd timer). The MCP server stays I/O-only.
//
// Usage:
//   chest-index [up]                 normal run: activation + decay + supersess + embed-cycle
//   chest-index up --all             same as bare `up`
//   chest-index up --activation      decay-aware ranking persistence only
//   chest-index up --decay           archive sweep only (cold/expired/dropped)
//   chest-index up --supersess       supersession sweep only
//   chest-index up --embed-cycle     embedding backfill (local sweep, or gemini batch cycle)
//   chest-index up --embed-submit-only   gemini submit phase only
//   chest-index up --embed-fetch-only    gemini fetch phase only
//   chest-index up --check           dry-run; show what would change, write nothing
//   chest-index status               embedding/provider status report
//   chest-index reembed              reset vectors from other providers to pending
//
// Exit codes:
//   0 ok / check / help
//   1 general error / permanent embedding API error
//   2 lock acquisition failed (another instance running)
//   3 DB init failed

import "../utils/temporal.js";
import { ensurePrismaInitialized, shutdownPrisma, prisma, rawAll, rawRun } from "../lib/db/prisma-client.js";
import { logger } from "../utils/logger.js";
import { acquireLock } from "./chest-index-flock.js";
import { runActivationPhase } from "../lib/activation.js";
import { runDecayPhase } from "../lib/decay.js";
import { activeProvider } from "../lib/embedding/provider.js";
import { runLocalPendingSweep } from "../lib/embedding/sync-embed.js";
import {
  MAX_SUBMIT_PER_CYCLE,
  MAX_FETCH_PER_CYCLE,
  MAX_SUBMIT_BATCHES,
} from "../lib/embedding/config.js";

type Mode =
  | "activation"
  | "decay"
  | "supersess"
  | "embed-cycle"
  | "embed-submit-only"
  | "embed-fetch-only";

type Command = "up" | "status" | "reembed";

const EMBED_MODES: ReadonlySet<Mode> = new Set<Mode>([
  "embed-cycle",
  "embed-submit-only",
  "embed-fetch-only",
]);

interface Args {
  command: Command;
  modes: Set<Mode>;
  all: boolean;
  check: boolean;
  force: boolean;
  verbose: boolean;
  quiet: boolean;
  help: boolean;
  maxSubmit: number;
  maxFetch: number;
  maxSubmitBatches: number;
  cycleId: string | undefined;
}

function parseUint(value: string | undefined, fallback: number, flag: string): number {
  if (value === undefined) {
    throw new Error(`[chest-index] ${flag} requires a numeric argument`);
  }
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new Error(`[chest-index] ${flag} must be a non-negative integer (got: ${value})`);
  }
  return n || fallback; // 0 is treated like "unset" (scheduler convenience)
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    command: "up",
    modes: new Set(),
    all: false,
    check: false,
    force: false,
    verbose: false,
    quiet: false,
    help: false,
    maxSubmit: MAX_SUBMIT_PER_CYCLE,
    maxFetch: MAX_FETCH_PER_CYCLE,
    maxSubmitBatches: MAX_SUBMIT_BATCHES,
    cycleId: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    switch (v) {
      case "up":
        a.command = "up";
        break;
      case "status":
        a.command = "status";
        break;
      case "reembed":
        a.command = "reembed";
        break;
      case "--all":
        a.all = true;
        break;
      case "--activation":
        a.modes.add("activation");
        break;
      case "--decay":
        a.modes.add("decay");
        break;
      case "--supersess":
        a.modes.add("supersess");
        break;
      case "--embed-cycle":
        a.modes.add("embed-cycle");
        break;
      case "--embed-submit-only":
        a.modes.add("embed-submit-only");
        break;
      case "--embed-fetch-only":
        a.modes.add("embed-fetch-only");
        break;
      case "--max-submit":
        a.maxSubmit = parseUint(argv[++i], MAX_SUBMIT_PER_CYCLE, "--max-submit");
        break;
      case "--max-fetch":
        a.maxFetch = parseUint(argv[++i], MAX_FETCH_PER_CYCLE, "--max-fetch");
        break;
      case "--max-submit-batches":
        a.maxSubmitBatches = parseUint(argv[++i], MAX_SUBMIT_BATCHES, "--max-submit-batches");
        break;
      case "--cycle-id":
        a.cycleId = argv[++i];
        break;
      case "--check":
        a.check = true;
        break;
      case "--force":
        a.force = true;
        break;
      case "--verbose":
        a.verbose = true;
        break;
      case "--quiet":
        a.quiet = true;
        break;
      case "-h":
      case "--help":
        a.help = true;
        break;
      default:
        process.stderr.write(`[chest-index] unknown argument: ${v}\n`);
        a.help = true;
    }
  }
  return a;
}

const HELP = `chest-index — unified maintenance CLI for chest-memory

USAGE
  chest-index [up]                 normal run: activation + decay + supersess + embed-cycle
  chest-index up --all             same as bare \`up\`
  chest-index up --activation      decay-aware ranking persistence
  chest-index up --decay           archive sweep (cold/expired/dropped)
  chest-index up --supersess       supersession sweep
  chest-index up --embed-cycle     embedding backfill (local sweep / gemini batch cycle)
  chest-index up --embed-submit-only   gemini submit phase only
  chest-index up --embed-fetch-only    gemini fetch phase only
  chest-index up --check           dry-run; show what would change, write nothing
  chest-index status               embedding & provider status report
  chest-index reembed              reset vectors produced by other providers to pending,
                                   then backfill with the active provider

EMBED-CYCLE OPTIONS (gemini provider)
  --max-submit N          max pending memories submitted per cycle (default ${MAX_SUBMIT_PER_CYCLE})
  --max-fetch M           max batches polled per cycle (default ${MAX_FETCH_PER_CYCLE})
  --max-submit-batches K  submit iterations per cycle (default ${MAX_SUBMIT_BATCHES})
  --cycle-id ID           pin the cycle_run_id (debugging)

COMMON
  --verbose       detailed per-phase logging (stderr)
  --quiet         suppress non-summary output
  -h, --help      this message

SCHEDULING: run \`chest-index up --all\` every ~10 minutes (cron or systemd timer).
The schema is managed by 'prisma migrate deploy'; the connection comes from
CHEST_DB_PATH (or an explicit DATABASE_URL).
`;

/** Resolve which phases to run, in order. */
function resolvePhases(args: Args): Mode[] {
  if (args.all || args.modes.size === 0) {
    return ["activation", "decay", "supersess", "embed-cycle"];
  }
  const order: Mode[] = [
    "activation",
    "decay",
    "supersess",
    "embed-cycle",
    "embed-submit-only",
    "embed-fetch-only",
  ];
  return order.filter((m) => args.modes.has(m));
}

function secs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

async function runGeminiCycle(phase: Mode, args: Args, summary: string[]): Promise<number> {
  const { runEmbedCycle } = await import("../lib/embedding/cycle.js");
  const { ProductionGeminiBatchClient } = await import("../lib/embedding/gemini-client.js");
  const { realClock } = await import("../lib/embedding/ports.js");

  try {
    await runEmbedCycle({
      prisma,
      gemini: new ProductionGeminiBatchClient(),
      logger,
      clock: realClock,
      maxSubmit: args.maxSubmit,
      maxFetch: args.maxFetch,
      maxSubmitBatches: args.maxSubmitBatches,
      cycleId: args.cycleId,
      submitOnly: phase === "embed-submit-only",
      fetchOnly: phase === "embed-fetch-only",
    });
    summary.push(
      `${phase.padEnd(11)}: completed (max-submit=${args.maxSubmit} max-fetch=${args.maxFetch})`,
    );
    return 0;
  } catch (err: unknown) {
    process.stderr.write(`[chest-index] embed-cycle error: ${(err as Error).message}\n`);
    logger.error({ err }, "[chest-index] embed-cycle fatal");
    return 1;
  }
}

async function runComputePhase(phase: Mode, args: Args, summary: string[]): Promise<number> {
  switch (phase) {
    case "activation": {
      const r = await runActivationPhase({ force: args.force, check: args.check });
      summary.push(
        `activation : ${r.updated} ${args.check ? "would update" : "updated"}, ${r.prunedAccessLog} access-log pruned (${secs(r.durationMs)})`,
      );
      return 0;
    }
    case "decay": {
      const r = await runDecayPhase({ check: args.check });
      summary.push(
        `decay      : ${r.compressed} compressed, ${r.expired} expired, ${r.swept} swept-to-archive (${secs(r.durationMs)})`,
      );
      return 0;
    }
    case "supersess": {
      const { runSupersessPhase } = await import("../lib/supersession.js");
      // The sweep operates on stored vectors only — no new embeddings here.
      const noopEmbed = async (): Promise<number[][]> => [];
      const r = await runSupersessPhase(noopEmbed, { check: args.check });
      summary.push(
        `supersess  : ${r.superseded ?? 0} superseded (sweep-only) (${secs(r.durationMs)})`,
      );
      return 0;
    }
    case "embed-cycle":
    case "embed-submit-only":
    case "embed-fetch-only": {
      const provider = activeProvider();
      if (provider.id === "local") {
        // Local provider: simple in-process backfill, no batch bookkeeping.
        if (args.check) {
          summary.push("embed-cycle: skipped (dry-run)");
          return 0;
        }
        const r = await runLocalPendingSweep(args.maxSubmit);
        summary.push(`embed-cycle: local sweep ${r.embedded}/${r.scanned} embedded`);
        return 0;
      }
      return runGeminiCycle(phase, args, summary);
    }
    default:
      process.stderr.write(`[chest-index] phase '${phase}' is not available in this build\n`);
      return 1;
  }
}

interface StatusRow {
  embedding_status: string;
  c: number;
}

async function runStatus(): Promise<number> {
  const provider = activeProvider();
  const byStatus = await rawAll<StatusRow>(
    prisma,
    "SELECT embedding_status, COUNT(*) AS c FROM memories WHERE archived_at IS NULL GROUP BY embedding_status",
  );
  const mismatch = await rawAll<{ c: number }>(
    prisma,
    `SELECT COUNT(*) AS c FROM memories
      WHERE embedding_status='done' AND archived_at IS NULL
        AND (embedding_model IS NOT ? OR embedding_dim IS NOT ?)`,
    provider.model,
    provider.dim,
  );
  const mismatchCount = Number(mismatch[0]?.c ?? 0);

  process.stdout.write(`[chest-index] status\n`);
  process.stdout.write(`  provider   : ${provider.id} (${provider.model}, ${provider.dim}-dim)\n`);
  for (const r of byStatus) {
    process.stdout.write(`  ${r.embedding_status.padEnd(11)}: ${r.c}\n`);
  }
  if (mismatchCount > 0) {
    process.stdout.write(
      `  NOT SEARCHABLE: ${mismatchCount} memories were embedded by a different provider\n` +
        `  and are excluded from vector recall. Run 'chest-index reembed' to re-index them\n` +
        `  with the current provider (full-text search is unaffected).\n`,
    );
  } else {
    process.stdout.write("  all done vectors match the current provider\n");
  }
  return 0;
}

async function runReembed(quiet: boolean): Promise<number> {
  const provider = activeProvider();
  const reset = await rawRun(
    prisma,
    `UPDATE memories
       SET embedding_status='pending', embedding_batch_id=NULL,
           embedding_state_changed_at=unixepoch()
     WHERE embedding_status='done' AND archived_at IS NULL
       AND (embedding_model IS NOT ? OR embedding_dim IS NOT ?)`,
    provider.model,
    provider.dim,
  );
  if (!quiet) {
    process.stdout.write(`[chest-index] reembed: ${reset} memories reset to pending\n`);
  }
  if (provider.id === "local") {
    let total = 0;
    // Sweep until the pending queue is drained or the model is unavailable.
    for (;;) {
      const r = await runLocalPendingSweep(200);
      total += r.embedded;
      if (r.scanned === 0 || r.embedded === 0) break;
    }
    if (!quiet) process.stdout.write(`[chest-index] reembed: ${total} re-embedded locally\n`);
  } else if (!quiet) {
    process.stdout.write(
      "[chest-index] reembed: rows will be re-embedded by the next 'up --embed-cycle' run\n",
    );
  }
  return 0;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const phases = resolvePhases(args);
  const hasEmbedMode = phases.some((p) => EMBED_MODES.has(p));

  // One lock for every command so maintenance runs never overlap.
  const lock = acquireLock();
  if (!lock) {
    process.stderr.write("[chest-index] another instance is running, skipping\n");
    return args.command === "up" && hasEmbedMode ? 2 : 0;
  }

  try {
    try {
      await ensurePrismaInitialized();
    } catch (err: unknown) {
      process.stderr.write(`[chest-index] DB init failed: ${(err as Error).message}\n`);
      return 3;
    }

    if (args.command === "status") return runStatus();
    if (args.command === "reembed") return runReembed(args.quiet);

    const summary: string[] = [];
    for (const phase of phases) {
      const code = await runComputePhase(phase, args, summary);
      if (code !== 0) return code;
    }

    if (!args.quiet && summary.length > 0) {
      const label = args.check ? "up --check (DRY RUN)" : `up (${phases.join("+")})`;
      process.stdout.write(`[chest-index] ${label}\n`);
      for (const line of summary) process.stdout.write(`  ${line}\n`);
    }
    return 0;
  } finally {
    lock.release();
    await shutdownPrisma();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    logger.error({ err }, "[chest-index] fatal");
    process.stderr.write(`[chest-index] fatal: ${(err as Error).message}\n`);
    process.exit(1);
  });
