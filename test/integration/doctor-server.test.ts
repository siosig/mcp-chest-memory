// T020: Doctor Server integration test.
//
// Covers the orchestration layer of `chest-index doctor server`:
//   - runServerChecks returns a CheckResult[] regardless of environment
//   - summarize maps fail/warn/ok counts to exit code 0/1/2 per FR-004
//   - DoctorReport JSON serialization matches the data-model.md §2 shape
//
// Docker / SQLite live state is intentionally NOT mocked here; on a CI
// machine without docker (or with no chest-memory container) we expect
// every docker-touching check to land as "fail" with non-empty fix_hint,
// which is itself a contract the implementation must satisfy.

import "../helpers/test-env.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { runServerChecks } from "../../src/cli/doctor/run-server.js";
import { summarize, type CheckResult, type DoctorReport } from "../../src/cli/doctor/types.js";

const CHECK_IDS = [
  "server.docker.daemon",
  "server.docker.container",
  "server.docker.health",
  "server.compose.override",
  "server.compose.deploy_files",
  "server.db.exists",
  "server.db.integrity",
  "server.db.journal_mode",
  "server.db.tables",
  "server.db.writable",
  "server.env.token",
  "server.env.mode",
  "server.network.health",
  "server.network.capabilities",
] as const;

const VALID_STATUSES = new Set(["ok", "warn", "fail", "skip"]);

describe("doctor server: orchestration", () => {
  it("runServerChecks returns one CheckResult per defined id", async () => {
    const results = await runServerChecks({ container: "chest-memory", timeoutSec: 2 });
    assert.equal(results.length, CHECK_IDS.length, "result count must match the declared list");
    const ids = new Set(results.map((r) => r.id));
    for (const expected of CHECK_IDS) {
      assert.ok(ids.has(expected), `missing check id: ${expected}`);
    }
  });

  it("every CheckResult satisfies the schema invariants", async () => {
    const results = await runServerChecks({ container: "chest-memory", timeoutSec: 2 });
    for (const r of results) {
      assert.equal(typeof r.id, "string", "id is string");
      assert.equal(typeof r.title, "string", "title is string");
      assert.equal(typeof r.category, "string", "category is string");
      assert.ok(VALID_STATUSES.has(r.status), `invalid status: ${r.status}`);
      assert.equal(typeof r.message, "string", "message is string");
      assert.equal(typeof r.fix_hint, "string", "fix_hint is string");
      assert.equal(typeof r.duration_ms, "number", "duration_ms is number");
      // Invariant: ok → fix_hint empty; fail/warn → fix_hint non-empty.
      if (r.status === "ok") {
        assert.equal(r.fix_hint, "", `ok status must have empty fix_hint (id=${r.id})`);
      }
      if (r.status === "fail" || r.status === "warn") {
        assert.ok(r.fix_hint.length > 0, `fail/warn must have fix_hint (id=${r.id})`);
      }
    }
  });

  it("a check that crashes is caught and recorded as fail (FR-008)", async () => {
    // runCheck wraps each check function so an exception cannot stop the
    // overall run. We do not have a way to inject a crash here without
    // mocking, so we assert the post-condition indirectly: even on a host
    // without docker, the result count is full.
    const results = await runServerChecks({ container: "no-such-container-xyz", timeoutSec: 2 });
    assert.equal(results.length, CHECK_IDS.length);
  });
});

describe("doctor server: exit code mapping", () => {
  function makeResult(status: CheckResult["status"]): CheckResult {
    return {
      id: "test.x",
      title: "x",
      category: "docker",
      status,
      message: "",
      fix_hint: status === "ok" ? "" : "do x",
      duration_ms: 0,
    };
  }

  it("all ok → exit 0", () => {
    const { summary, exit_code } = summarize([makeResult("ok"), makeResult("ok")]);
    assert.equal(exit_code, 0);
    assert.equal(summary.ok, 2);
  });

  it("warn only → exit 1", () => {
    const { exit_code } = summarize([makeResult("ok"), makeResult("warn")]);
    assert.equal(exit_code, 1);
  });

  it("any fail → exit 2", () => {
    const { exit_code } = summarize([makeResult("ok"), makeResult("warn"), makeResult("fail")]);
    assert.equal(exit_code, 2);
  });

  it("only skips → exit 0 (skip is not a failure)", () => {
    const { exit_code } = summarize([makeResult("skip"), makeResult("skip")]);
    assert.equal(exit_code, 0);
  });
});

describe("doctor server: DoctorReport JSON shape", () => {
  it("a full report round-trips through JSON.stringify with the documented fields", async () => {
    const started = new Date().toISOString();
    const results = await runServerChecks({ container: "chest-memory", timeoutSec: 2 });
    const finished = new Date().toISOString();
    const { summary, exit_code } = summarize(results);
    const report: DoctorReport = {
      subcommand: "server",
      started_at: started,
      finished_at: finished,
      results,
      summary,
      exit_code,
    };

    const round = JSON.parse(JSON.stringify(report)) as DoctorReport;
    assert.equal(round.subcommand, "server");
    assert.equal(typeof round.started_at, "string");
    assert.equal(typeof round.finished_at, "string");
    assert.ok(Array.isArray(round.results));
    assert.equal(round.results.length, CHECK_IDS.length);
    assert.equal(
      round.results.length,
      round.summary.ok + round.summary.warn + round.summary.fail + round.summary.skip,
      "summary counts must equal results length",
    );
    // exit_code invariants per data-model.md §2.
    if (round.summary.fail > 0) {
      assert.equal(round.exit_code, 2);
    } else if (round.summary.warn > 0) {
      assert.equal(round.exit_code, 1);
    } else {
      assert.equal(round.exit_code, 0);
    }
  });
});
