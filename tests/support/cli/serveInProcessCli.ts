import type { CliInstance } from "../../../src/cli/types.js";

/** Captured output and effective status of one isolated in-process invocation. */
export interface ServedCli {
  readonly stdout: string;
  readonly exitCode: number;
}

/** Mirror a fresh CLI process while preserving the test worker's exit state. */
export const serveInProcessCli = async (
  cli: Pick<CliInstance, "serve">,
  argv: readonly string[],
): Promise<ServedCli> => {
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  let stdout = "";
  let explicitExit: number | undefined;
  try {
    await cli.serve([...argv], {
      env: {},
      exit: (code) => {
        explicitExit = code;
      },
      stdout: (text) => {
        stdout += text;
      },
    });
    // Incur's callback models an explicit process.exit. Otherwise REA's
    // command-owned process.exitCode determines the final process status.
    return {
      stdout,
      exitCode: explicitExit ?? Number(process.exitCode ?? 0),
    };
  } finally {
    process.exitCode = previousExitCode;
  }
};
