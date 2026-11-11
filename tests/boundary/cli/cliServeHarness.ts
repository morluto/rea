import { expect } from "vitest";

import { createCli } from "../../../src/cli.js";
import {
  serveInProcessCli,
  type ServedCli,
} from "../../support/cli/serveInProcessCli.js";

/** Serve one CLI invocation with captured output and exit code. */
export const serveCli = async (
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = {},
): Promise<ServedCli> => serveInProcessCli(createCli(environment), argv);

/** A host tool configuration refusal names what to configure, not the target. */
export const expectConfigurationRefusal = (
  result: ServedCli,
  reason: string,
): void => {
  expect(result.exitCode, result.stdout).toBe(1);
  const output = JSON.parse(result.stdout) as {
    code?: unknown;
    message?: unknown;
    remediation?: { action?: unknown };
  };
  expect(output.code).toBe("capability_unavailable");
  expect(output.message).toEqual(expect.stringContaining(reason));
  expect(output.remediation?.action).toEqual(expect.stringContaining(reason));
};
