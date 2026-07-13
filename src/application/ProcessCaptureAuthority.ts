import { realpath } from "node:fs/promises";

import type {
  ProcessExecutionPolicy,
  ProcessScenario,
} from "../domain/processCapture.js";
import { ProcessCaptureError } from "./ProcessCaptureError.js";

const isWithin = (candidate: string, root: string): boolean =>
  candidate === root ||
  candidate.startsWith(`${root.endsWith("/") ? root.slice(0, -1) : root}/`);

export const assertRealPathAuthority = async (
  scenario: ProcessScenario,
  policy: ProcessExecutionPolicy,
): Promise<void> => {
  const executable = await realpath(scenario.executable);
  const executableRoots = await Promise.all(
    policy.executableRoots.map((root) => realpath(root)),
  );
  if (!executableRoots.some((root) => isWithin(executable, root)))
    throw new ProcessCaptureError(
      "resolved executable is outside approved roots",
    );
  const workingDirectory = await realpath(scenario.working_directory);
  const workingRoots = await Promise.all(
    policy.workingRoots.map((root) => realpath(root)),
  );
  if (!workingRoots.some((root) => isWithin(workingDirectory, root)))
    throw new ProcessCaptureError(
      "resolved working directory is outside approved roots",
    );
  for (const root of scenario.filesystem_roots) {
    const resolvedRoot = await realpath(root);
    if (!workingRoots.some((approved) => isWithin(resolvedRoot, approved)))
      throw new ProcessCaptureError(
        "resolved filesystem root is outside approved roots",
      );
  }
};

/** Expected refusal or runtime failure from the process capture adapter. */
export const assertNotCancelled = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted === true)
    throw new ProcessCaptureError("process capture was cancelled");
};

/** Runtime availability of the native PTY adapter on this host. */
