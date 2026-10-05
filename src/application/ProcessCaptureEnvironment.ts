import type { ProcessScenario } from "../domain/processCapture.js";

interface ProcessCaptureEnvironmentOptions {
  readonly scenario: ProcessScenario;
  readonly runId: string;
  readonly hostEnvironment: Readonly<Record<string, string | undefined>>;
}

/** Build the child environment from the host plus caller-selected overrides. */
export const makeProcessCaptureEnvironment = (
  options: ProcessCaptureEnvironmentOptions,
): Record<string, string> => ({
  ...Object.fromEntries(
    Object.entries(options.hostEnvironment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  ),
  ...options.scenario.environment,
  TERM:
    options.scenario.environment.TERM ??
    options.hostEnvironment.TERM ??
    "xterm-256color",
  REA_PROCESS_RUN_ID: options.runId,
});
