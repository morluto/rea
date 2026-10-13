import { constants as fsConstants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";

import type { ProcessScenario } from "../../domain/process/processScenario.js";
import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import { snapshotEnvironment } from "../snapshotEnvironment.js";
import { processCaptureCancelled } from "./ProcessCaptureError.js";

/** Resolve caller-selected executable and observation paths for this execution. */
export const resolveProcessScenarioRuntimePaths = async (
  scenario: ProcessScenario,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<ProcessScenario> => {
  const selectedWorkingDirectory = resolve(scenario.working_directory);
  let workingDirectory: string;
  try {
    workingDirectory = await realpath(selectedWorkingDirectory);
  } catch (cause: unknown) {
    throw invalidScenarioPath(
      "working_directory",
      `working directory could not be resolved: ${selectedWorkingDirectory}${osFailure(cause)}`,
      cause,
    );
  }
  let workingDirectoryStat;
  try {
    workingDirectoryStat = await stat(workingDirectory);
  } catch (cause: unknown) {
    throw invalidScenarioPath(
      "working_directory",
      `working directory could not be inspected: ${workingDirectory}${osFailure(cause)}`,
      cause,
    );
  }
  if (!workingDirectoryStat.isDirectory())
    throw invalidScenarioPath(
      "working_directory",
      `working directory is not a directory: ${workingDirectory}`,
    );
  const executable = await resolveExecutable(
    scenario.executable,
    workingDirectory,
    snapshotEnvironment(scenario.environment, platform).PATH ??
      snapshotEnvironment(environment, platform).PATH ??
      "",
  );
  const observationPaths = scenario.filesystem_observation_paths.map((path) =>
    resolve(workingDirectory, path),
  );
  return {
    ...scenario,
    executable,
    working_directory: workingDirectory,
    filesystem_observation_paths: observationPaths,
  };
};

/** Resolve a selected executable through the caller's effective PATH. */
export const resolveExecutable = async (
  command: string,
  workingDirectory: string,
  searchPath: string,
): Promise<string> => {
  const directories = searchPath
    .split(delimiter)
    .map((directory) =>
      directory === ""
        ? workingDirectory
        : resolve(workingDirectory, directory),
    );
  const candidates =
    isAbsolute(command) || command.includes("/") || command.includes("\\")
      ? [resolve(workingDirectory, command)]
      : directories.map((directory) => join(directory, command));
  const failures: string[] = [];
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      if ((await stat(candidate)).isFile()) return candidate;
      failures.push(`${candidate} (not a regular file)`);
    } catch (cause: unknown) {
      failures.push(`${candidate}${osFailure(cause)}`);
      continue;
    }
  }
  throw invalidScenarioPath(
    "executable",
    `executable could not be resolved: ${command}; checked ${failures.join("; ")}`,
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
  if (signal?.aborted === true) throw processCaptureCancelled();
};
