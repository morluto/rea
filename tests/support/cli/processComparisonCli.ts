import { Cli } from "incur";
import pino from "pino";

import { registerProcessCommands } from "../../../src/cli/processCommands.js";
import { serveInProcessCli } from "./serveInProcessCli.js";

/**
 * Run `compare-process-captures` in process on capture and trace
 * specification files, returning its JSON output.
 */
export const compareProcessCaptureFiles = async (
  left: string,
  right: string,
  traceSpecification?: string,
): Promise<unknown> => {
  const cli = Cli.create("rea", { sync: false });
  registerProcessCommands(cli, pino({ level: "silent" }), {});
  const { stdout } = await serveInProcessCli(cli, [
    "compare-process-captures",
    left,
    right,
    ...(traceSpecification === undefined ? [] : [traceSpecification]),
    "--json",
  ]);
  return JSON.parse(stdout) as unknown;
};
