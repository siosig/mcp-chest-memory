// Contract test: chest-index CLI argument-parsing surface (offline only —
// no database is touched). Compute-phase behavior is covered by the
// integration suite.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../../src/cli/chest-index.ts", import.meta.url));

function runCli(args: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], { encoding: "utf8" });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

test("--help exits 0 and lists every command and mode flag", () => {
  const r = runCli(["--help"]);
  assert.equal(r.code, 0);
  for (const f of [
    "--all",
    "--activation",
    "--decay",
    "--supersess",
    "--embed-cycle",
    "--check",
    "status",
    "reembed",
  ]) {
    assert.ok(r.stdout.includes(f), `help missing ${f}`);
  }
  // Schema management belongs to Prisma; the help text points users there.
  assert.match(r.stdout, /prisma migrate deploy/);
});

test("unknown argument prints a warning plus help and exits 0", () => {
  const r = runCli(["--no-such-flag"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /unknown argument/);
  assert.match(r.stdout, /USAGE/);
});
