// chest-index doctor — diagnostic CLI dispatcher.
//
// Subcommands:
//   chest-index doctor server   — Docker / DB / compose / env / network checks
//   chest-index doctor client   — MCP / rules / skills / model cache / conn checks
//
// Exit codes: 0 all ok, 1 warn only, 2 at least one fail.

import { formatJson, formatText } from "./report.js";
import { summarize, type CheckResult, type DoctorReport } from "./types.js";

interface DoctorArgs {
  doctorTarget: "server" | "client" | "";
  json: boolean;
  container: string;
  remoteUrl: string;
  timeout: number;
}

export async function runDoctor(args: DoctorArgs): Promise<number> {
  if (args.doctorTarget !== "server" && args.doctorTarget !== "client") {
    process.stderr.write(
      "[chest-index] doctor requires a target: 'server' or 'client'\n" +
        "  chest-index doctor server\n" +
        "  chest-index doctor client\n",
    );
    return 1;
  }

  const started = new Date().toISOString();
  let results: CheckResult[];
  if (args.doctorTarget === "server") {
    const { runServerChecks } = await import("./run-server.js");
    results = await runServerChecks({
      container: args.container,
      timeoutSec: args.timeout,
    });
  } else {
    const { runClientChecks } = await import("./run-client.js");
    results = await runClientChecks({
      remoteUrl: args.remoteUrl,
      timeoutSec: args.timeout,
    });
  }
  const finished = new Date().toISOString();
  const { summary, exit_code } = summarize(results);
  const report: DoctorReport = {
    subcommand: args.doctorTarget,
    started_at: started,
    finished_at: finished,
    results,
    summary,
    exit_code,
  };
  const color = !args.json && process.stdout.isTTY === true;
  process.stdout.write(args.json ? formatJson(report) : formatText(report, { color }));
  process.stdout.write("\n");
  return exit_code;
}
