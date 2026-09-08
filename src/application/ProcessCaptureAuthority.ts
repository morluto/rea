import { realpath } from "node:fs/promises";
import { isPathWithinRoot } from "../domain/localPath.js";

import type {
  EnabledProcessExecutionPolicy,
  ProcessScenario,
} from "../domain/processCapture.js";
import {
  ProcessCaptureError,
  processCaptureCancelled,
} from "./ProcessCaptureError.js";
import { canonicalizeConfiguredRoots } from "./ConfiguredRoots.js";

export const assertRealPathAuthority = async (
  scenario: ProcessScenario,
  policy: EnabledProcessExecutionPolicy,
): Promise<void> => {
  const executable = await realpath(scenario.executable);
  const executableRoots = await canonicalizeConfiguredRoots(
    policy.executableRoots,
  );
  if (!executableRoots.some((root) => isPathWithinRoot(root, executable)))
    throw new ProcessCaptureError(
      "resolved executable is outside approved roots",
    );
  const workingDirectory = await realpath(scenario.working_directory);
  const workingRoots = await canonicalizeConfiguredRoots(policy.workingRoots);
  if (!workingRoots.some((root) => isPathWithinRoot(root, workingDirectory)))
    throw new ProcessCaptureError(
      "resolved working directory is outside approved roots",
    );
  for (const root of scenario.filesystem_roots) {
    const resolvedRoot = await realpath(root);
    if (
      !workingRoots.some((approved) => isPathWithinRoot(approved, resolvedRoot))
    )
      throw new ProcessCaptureError(
        "resolved filesystem root is outside approved roots",
      );
  }
};

/** Reject cancellation before a process capture operation begins. */
export const assertNotCancelled = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted === true) throw processCaptureCancelled();
};
