// Doctor report formatters: human-readable text + JSON.

import type { CheckStatus, DoctorReport } from "./types.js";

const ICONS: Record<CheckStatus, string> = {
  ok: "[ok]  ",
  warn: "[warn]",
  fail: "[fail]",
  skip: "[skip]",
};

interface FormatOptions {
  /** When false, ANSI color escapes are suppressed (non-TTY / --json mode). */
  color?: boolean;
}

function paint(s: string, code: number, color: boolean): string {
  if (!color) return s;
  return `[${code}m${s}[0m`;
}

function colorize(status: CheckStatus, label: string, color: boolean): string {
  switch (status) {
    case "ok":
      return paint(label, 32, color);
    case "warn":
      return paint(label, 33, color);
    case "fail":
      return paint(label, 31, color);
    case "skip":
      return paint(label, 90, color);
  }
}

export function formatText(report: DoctorReport, opts: FormatOptions = {}): string {
  const color = opts.color ?? false;
  const lines: string[] = [];
  lines.push(`chest-index doctor ${report.subcommand} (started ${report.started_at})`);
  lines.push("");
  for (const r of report.results) {
    lines.push(`${colorize(r.status, ICONS[r.status], color)} ${r.id.padEnd(36)} ${r.title}`);
    if (r.message) lines.push(`         ${r.message}`);
    if (r.status !== "ok" && r.fix_hint) {
      lines.push(`         fix: ${r.fix_hint}`);
    }
  }
  lines.push("");
  const s = report.summary;
  lines.push(`Summary: ok=${s.ok} warn=${s.warn} fail=${s.fail} skip=${s.skip}`);
  lines.push(`Exit code: ${report.exit_code}`);
  return lines.join("\n");
}

export function formatJson(report: DoctorReport): string {
  return JSON.stringify(report, null, 2);
}
