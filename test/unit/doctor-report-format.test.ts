// Unit tests for the doctor report formatters (spec 014, T071).

import { test } from "node:test";
import assert from "node:assert/strict";

import { formatText, formatJson } from "../../src/cli/doctor/report.js";
import { summarize, type CheckResult, type DoctorReport } from "../../src/cli/doctor/types.js";

// The ESC byte (0x1b) begins every ANSI SGR escape. The status icons themselves
// contain literal "[" characters, so detection MUST anchor on the ESC byte —
// not on a bare "[".
const ESC = String.fromCharCode(27);
const hasAnsi = (s: string): boolean => s.includes(ESC);

function makeReport(): DoctorReport {
  const results: CheckResult[] = [
    {
      id: "server.docker.daemon",
      title: "Docker daemon reachable",
      category: "docker",
      status: "ok",
      message: "docker info succeeded",
      fix_hint: "",
      duration_ms: 12,
    },
    {
      id: "server.compose.override",
      title: "compose.override.yaml is applied",
      category: "compose",
      status: "fail",
      message: "override file not present in config_files",
      fix_hint: "docker compose -f deploy/docker/compose.yaml -f deploy/docker/compose.override.yaml up -d",
      duration_ms: 8,
    },
    {
      id: "server.env.token",
      title: "CHEST_API_TOKEN set",
      category: "env",
      status: "warn",
      message: "token looks like a placeholder",
      fix_hint: "set a strong CHEST_API_TOKEN",
      duration_ms: 1,
    },
    {
      id: "server.http.capabilities",
      title: "/capabilities reachable",
      category: "network",
      status: "skip",
      message: "skipped: container not running",
      fix_hint: "",
      duration_ms: 0,
    },
  ];
  const { summary, exit_code } = summarize(results);
  return {
    subcommand: "server",
    started_at: "2026-06-13T00:00:00.000Z",
    finished_at: "2026-06-13T00:00:01.000Z",
    results,
    summary,
    exit_code,
  };
}

test("formatText (non-TTY): no ANSI escapes, contains status icons", () => {
  const out = formatText(makeReport(), { color: false });
  assert.equal(hasAnsi(out), false, "must not emit ANSI escapes when color disabled");
  assert.ok(out.includes("[ok]"));
  assert.ok(out.includes("[fail]"));
  assert.ok(out.includes("[warn]"));
  assert.ok(out.includes("[skip]"));
});

test("formatText default suppresses color (FR-003 auto-disable)", () => {
  const out = formatText(makeReport());
  assert.equal(hasAnsi(out), false);
});

test("formatText (TTY): emits ANSI color escapes", () => {
  const out = formatText(makeReport(), { color: true });
  assert.equal(hasAnsi(out), true, "expected colored status labels");
});

test("formatText shows fix hints only for non-ok checks", () => {
  const out = formatText(makeReport(), { color: false });
  assert.ok(out.includes("fix: docker compose -f deploy/docker/compose.yaml"));
  assert.ok(out.includes("fix: set a strong CHEST_API_TOKEN"));
  // The ok check's empty fix_hint must not be printed.
  const fixLines = out.split("\n").filter((l) => l.trim().startsWith("fix:"));
  assert.equal(fixLines.length, 2);
});

test("formatText includes the summary line and exit code", () => {
  const out = formatText(makeReport(), { color: false });
  assert.ok(out.includes("Summary: ok=1 warn=1 fail=1 skip=1"));
  assert.ok(out.includes("Exit code: 2"));
});

test("formatJson round-trips to the same report object", () => {
  const report = makeReport();
  const parsed = JSON.parse(formatJson(report));
  assert.deepEqual(parsed, JSON.parse(JSON.stringify(report)));
  // JSON output never carries ANSI escapes.
  assert.equal(hasAnsi(formatJson(report)), false);
});

test("summarize: exit code precedence fail > warn > ok", () => {
  const base = (status: CheckResult["status"]): CheckResult => ({
    id: "x",
    title: "x",
    category: "config",
    status,
    message: "",
    fix_hint: "",
    duration_ms: 0,
  });
  assert.equal(summarize([base("ok")]).exit_code, 0);
  assert.equal(summarize([base("ok"), base("warn")]).exit_code, 1);
  assert.equal(summarize([base("warn"), base("fail")]).exit_code, 2);
  assert.equal(summarize([base("skip")]).exit_code, 0);
});
