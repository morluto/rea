import { createCli } from "../../../src/cli.js";

/** Captured CLI invocation for boundary tests. */
export interface ServedCli {
  readonly stdout: string;
  readonly exitCode: number;
}

/** Serve one CLI invocation with captured output and exit code. */
export const serveCli = async (
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = {},
): Promise<ServedCli> => {
  const cli = createCli(environment);
  let stdout = "";
  let exitCode = 0;
  await cli.serve([...argv], {
    env: {},
    exit: (code) => {
      exitCode = code;
    },
    stdout: (text) => {
      stdout += text;
    },
  });
  return { stdout, exitCode };
};
