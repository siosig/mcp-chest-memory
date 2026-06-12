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
//   chest-index up --embed-cycle     embedding backfill of pending rows
//   chest-index up --check           dry-run; show what would change, write nothing
//   chest-index status               embedding status report
//   chest-index reembed              re-index vectors after an embedding model change
//
// Exit codes:
//   0 ok / check / help
//   1 general error
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
import { SWEEP_LIMIT } from "../lib/embedding/config.js";

type Mode = "activation" | "decay" | "supersess" | "embed-cycle";

type Command = "up" | "status" | "reembed";

interface Args {
  command: Command;
  modes: Set<Mode>;
  all: boolean;
  check: boolean;
  force: boolean;
  verbose: boolean;
  quiet: boolean;
  help: boolean;
  sweepLimit: number;
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
    sweepLimit: SWEEP_LIMIT,
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
      case "--sweep-limit":
        a.sweepLimit = parseUint(argv[++i], SWEEP_LIMIT, "--sweep-limit");
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
  chest-index up --embed-cycle     embedding backfill of pending rows
  chest-index up --check           dry-run; show what would change, write nothing
  chest-index status               embedding status report
  chest-index reembed              reset vectors from an older embedding model to
                                   pending, then backfill with the current model

OPTIONS
  --sweep-limit N  max rows backfilled per embedding sweep (default ${SWEEP_LIMIT})
  --verbose        detailed per-phase logging (stderr)
  --quiet          suppress non-summary output
  -h, --help       this message

SCHEDULING: run \`chest-index up --all\` every ~10 minutes (cron or systemd timer).
The schema is managed by 'prisma migrate deploy'; the connection comes from
CHEST_DB_PATH (or an explicit DATABASE_URL).
`;

/** Resolve which phases to run, in order. */
function resolvePhases(args: Args): Mode[] {
  if (args.all || args.modes.size === 0) {
    return ["activation", "decay", "supersess", "embed-cycle"];
  }
  const order: Mode[] = ["activation", "decay", "supersess", "embed-cycle"];
  return order.filter((m) => args.modes.has(m));
}

function secs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
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
    case "embed-cycle": {
      if (args.check) {
        summary.push("embed-cycle: skipped (dry-run)");
        return 0;
      }
      const r = await runLocalPendingSweep(args.sweepLimit);
      summary.push(`embed-cycle: ${r.embedded}/${r.scanned} pending rows embedded`);
      return 0;
    }
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
  process.stdout.write(`  model      : ${provider.model} (${provider.dim}-dim)\n`);
  for (const r of byStatus) {
    process.stdout.write(`  ${r.embedding_status.padEnd(11)}: ${r.c}\n`);
  }
  if (mismatchCount > 0) {
    process.stdout.write(
      `  NOT SEARCHABLE: ${mismatchCount} memories were embedded by a different model\n` +
        `  and are excluded from vector recall. Run 'chest-index reembed' to re-index\n` +
        `  them (full-text search is unaffected).\n`,
    );
  } else {
    process.stdout.write("  all done vectors match the current model\n");
  }
  return 0;
}

async function runReembed(quiet: boolean): Promise<number> {
  const provider = activeProvider();
  const reset = await rawRun(
    prisma,
    `UPDATE memories
       SET embedding_status='pending',
           embedding_state_changed_at=unixepoch()
     WHERE embedding_status='done' AND archived_at IS NULL
       AND (embedding_model IS NOT ? OR embedding_dim IS NOT ?)`,
    provider.model,
    provider.dim,
  );
  if (!quiet) {
    process.stdout.write(`[chest-index] reembed: ${reset} memories reset to pending\n`);
  }
  let total = 0;
  // Sweep until the pending queue is drained or the model is unavailable.
  for (;;) {
    const r = await runLocalPendingSweep(200);
    total += r.embedded;
    if (r.scanned === 0 || r.embedded === 0) break;
  }
  if (!quiet) process.stdout.write(`[chest-index] reembed: ${total} re-embedded\n`);
  return 0;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const phases = resolvePhases(args);

  // One lock for every command so maintenance runs never overlap.
  const lock = acquireLock();
  if (!lock) {
    process.stderr.write("[chest-index] another instance is running, skipping\n");
    return args.command === "up" ? 2 : 0;
  }

  try {
    try {
      await ensurePrismaInitialized();
    } catch (err: unknown) {
      process.stderr.write(`[chest-index] DB init failed: ${(err as Error).message}\n`);
      return 3;
    }

    // `return await` matters here: without it, the finally block (which
    // disconnects Prisma) would run while these async commands are still
    // querying, killing the engine mid-flight.
    if (args.command === "status") return await runStatus();
    if (args.command === "reembed") return await runReembed(args.quiet);

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
