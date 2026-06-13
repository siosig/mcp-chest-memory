// Doctor diagnostic types.
//
// CheckResult represents a single check; DoctorReport aggregates a full
// `chest-index doctor server` or `chest-index doctor client` invocation.
// See specs/014-doctor-healthcheck/data-model.md §1–§2.

export type CheckStatus = "ok" | "warn" | "fail" | "skip";

export type CheckCategory =
  | "docker"
  | "db"
  | "compose"
  | "env"
  | "network"
  | "config"
  | "model";

export interface CheckResult {
  /** Dot-separated unique ID, e.g. "server.docker.daemon". */
  id: string;
  /** Human-readable title. */
  title: string;
  category: CheckCategory;
  status: CheckStatus;
  /** Detail message shown under the title. */
  message: string;
  /** Concrete fix steps; empty string when status is "ok". */
  fix_hint: string;
  duration_ms: number;
}

export type Subcommand = "server" | "client";

export interface ReportSummary {
  ok: number;
  warn: number;
  fail: number;
  skip: number;
}

export interface DoctorReport {
  subcommand: Subcommand;
  started_at: string;
  finished_at: string;
  results: CheckResult[];
  summary: ReportSummary;
  /** 0 all ok, 1 warn only, 2 at least one fail. */
  exit_code: 0 | 1 | 2;
}

/** Compute exit_code and summary from a result array. */
export function summarize(results: CheckResult[]): { summary: ReportSummary; exit_code: 0 | 1 | 2 } {
  const summary: ReportSummary = { ok: 0, warn: 0, fail: 0, skip: 0 };
  for (const r of results) summary[r.status]++;
  const exit_code: 0 | 1 | 2 = summary.fail > 0 ? 2 : summary.warn > 0 ? 1 : 0;
  return { summary, exit_code };
}

/** A check runner: returns the CheckResult for one item. */
export type CheckFn = () => Promise<CheckResult>;

/** Run a check function, catching any thrown error as a `fail` result. */
export async function runCheck(id: string, title: string, category: CheckCategory, fn: () => Promise<Omit<CheckResult, "id" | "title" | "category" | "duration_ms">>): Promise<CheckResult> {
  const start = Date.now();
  try {
    const partial = await fn();
    return { id, title, category, ...partial, duration_ms: Date.now() - start };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      id,
      title,
      category,
      status: "fail",
      message: `check crashed: ${msg}`,
      fix_hint: "Investigate stack trace; this check itself is buggy.",
      duration_ms: Date.now() - start,
    };
  }
}
