import type { ProcessResult } from "../process/processFixture.js";

/** Normalized result from the compiled REA CLI. */
export interface CliResult extends ProcessResult {
  readonly json: unknown | undefined;
}

const parseCliStdout = (stdout: string): unknown | undefined => {
  const document = stdout.trim();
  if (document.length === 0) return undefined;
  try {
    return JSON.parse(document) as unknown;
  } catch {
    return undefined;
  }
};

export const withParsedStdout = (result: ProcessResult): CliResult => ({
  ...result,
  json: parseCliStdout(result.stdout),
});
