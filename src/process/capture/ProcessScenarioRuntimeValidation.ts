import { realpath, stat } from "node:fs/promises";

import { absoluteCallerPath } from "../../filesystem/callerPath.js";

import type { ProcessScenario } from "../../domain/process/processScenario.js";
import {
  AnalysisAccessDeniedError,
  AnalysisInputError,
} from "../../domain/analysisErrorCore.js";
import { lookupExecutable } from "../ExecutableLookup.js";
import { snapshotEnvironment } from "../snapshotEnvironment.js";
import { processCaptureCancelled } from "./ProcessCaptureError.js";

/** Resolve caller-selected executable and observation paths for this execution. */
export const resolveProcessScenarioRuntimePaths = async (
  scenario: ProcessScenario,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<ProcessScenario> => {
  const selectedWorkingDirectory = absoluteCallerPath(
    scenario.working_directory,
  );
  let workingDirectory: string;
  try {
    workingDirectory = await realpath(selectedWorkingDirectory);
  } catch (cause: unknown) {
    throw (
      hostAccessDenial(selectedWorkingDirectory, cause) ??
      invalidScenarioPath(
        "working_directory",
        `working directory could not be resolved: ${selectedWorkingDirectory}${osFailure(cause)}`,
        cause,
      )
    );
  }
  let workingDirectoryStat;
  try {
    workingDirectoryStat = await stat(workingDirectory);
  } catch (cause: unknown) {
    throw (
      hostAccessDenial(selectedWorkingDirectory, cause) ??
      invalidScenarioPath(
        "working_directory",
        `working directory could not be inspected: ${selectedWorkingDirectory}${osFailure(cause)}`,
        cause,
      )
    );
  }
  if (!workingDirectoryStat.isDirectory())
    throw invalidScenarioPath(
      "working_directory",
      `working directory is not a directory: ${selectedWorkingDirectory}`,
    );
  const executable = await resolveExecutable(
    scenario.executable,
    workingDirectory,
    snapshotEnvironment(scenario.environment, platform).PATH ??
      snapshotEnvironment(environment, platform).PATH,
  );
  const observationPaths = scenario.filesystem_observation_paths.map((path) =>
    absoluteCallerPath(path, { cwd: workingDirectory }),
  );
  return {
    ...scenario,
    executable,
    working_directory: workingDirectory,
    filesystem_observation_paths: observationPaths,
  };
};

/**
 * Resolve a selected executable through the caller's effective PATH. A denied
 * lookup of an explicitly selected path is a host access failure; PATH search
 * continues past denied directories, and an existing file without execute
 * permission remains an invalid selection.
 */
export const resolveExecutable = async (
  command: string,
  workingDirectory: string,
  searchPath: string | undefined,
): Promise<string> => {
  const lookup = await lookupExecutable(
    command,
    () => workingDirectory,
    searchPath,
  );
  if (lookup.status === "found") return lookup.path;
  if (lookup.status === "denied")
    throw new AnalysisAccessDeniedError(
      "capture_process_scenario",
      lookup.path,
      lookup.code,
      { cause: lookup.cause },
    );
  // The scenario's working directory is already resolved, so it is readable.
  if (lookup.status === "no-working-directory")
    throw invalidScenarioPath(
      "working_directory",
      `working directory could not be read: ${workingDirectory}`,
      lookup.cause,
    );
  // An unbounded lookup cannot be interrupted.
  if (lookup.status === "interrupted")
    throw invalidScenarioPath(
      "executable",
      `executable lookup was interrupted: ${command}`,
    );
  throw invalidScenarioPath(
    "executable",
    `executable could not be resolved: ${command}; checked ${lookup.checked.join("; ")}`,
  );
};

const invalidScenarioPath = (
  field: "executable" | "working_directory",
  message: string,
  cause?: unknown,
): AnalysisInputError =>
  new AnalysisInputError(
    "capture_process_scenario",
    cause === undefined ? undefined : { cause },
    [{ path: [field], reason: "invalid_value", message }],
  );

/** Host permissions denied resolving a selected path; not malformed input. */
const hostAccessDenial = (
  selected: string,
  cause: unknown,
): AnalysisAccessDeniedError | undefined => {
  const code = osErrorCode(cause);
  return code === "EACCES" || code === "EPERM"
    ? new AnalysisAccessDeniedError(
        "capture_process_scenario",
        selected,
        code,
        {
          cause,
        },
      )
    : undefined;
};

const osErrorCode = (cause: unknown): string | undefined =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  typeof cause.code === "string"
    ? cause.code
    : undefined;

const osFailure = (cause: unknown): string => {
  const code = osErrorCode(cause);
  return code === undefined ? "" : ` (${code})`;
};

/** Reject cancellation before a process capture operation begins. */
export const assertNotCancelled = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted === true) throw processCaptureCancelled(signal.reason);
};
