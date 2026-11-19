import type { ProcessScenario } from "../../domain/process/processScenario.js";
import { HOST_PLATFORM } from "../../platform/HostPlatform.js";
import {
  mergeEnvironmentOverrides,
  snapshotEnvironment,
} from "../snapshotEnvironment.js";

interface ProcessCaptureEnvironmentOptions {
  readonly scenario: ProcessScenario;
  readonly runId: string;
  readonly hostEnvironment: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
}

/** Build the child environment from the host plus caller-selected overrides. */
export const makeProcessCaptureEnvironment = (
  options: ProcessCaptureEnvironmentOptions,
): Record<string, string> => {
  const platform = options.platform ?? HOST_PLATFORM.platform;
  const environment = snapshotEnvironment(
    mergeEnvironmentOverrides(
      options.hostEnvironment,
      options.scenario.environment,
      platform,
    ),
    platform,
  );
  return {
    ...Object.fromEntries(
      Object.entries(environment).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    TERM: environment.TERM ?? "xterm-256color",
    REA_PROCESS_RUN_ID: options.runId,
  };
};
