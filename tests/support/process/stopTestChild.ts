import type {
  ProviderProcessHandle,
  ProviderProcessStopResult,
  ProviderProcessSupervisor,
} from "../../../src/process/ProviderProcess.js";

/**
 * Force-stop a synthetic test child process when production cleanup fails or
 * throws, re-referencing the handle until its `exit` event confirms reaping.
 */
export const stopTestChild = async (
  child: ProviderProcessHandle,
): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.ref?.();
  await new Promise<void>((resolve) => {
    const onExit = (): void => resolve();
    child.once("exit", onExit);
    if (
      !child.kill("SIGKILL") ||
      child.exitCode !== null ||
      child.signalCode !== null
    ) {
      child.off("exit", onExit);
      resolve();
    }
  });
};

/**
 * Stop a retained test process supervisor while guaranteeing its underlying
 * synthetic child is reaped if production cleanup reports incomplete or throws.
 */
export const stopTestOwner = async (
  owner: ProviderProcessSupervisor,
): Promise<ProviderProcessStopResult> => {
  let completed = false;
  try {
    const stopped = await owner.stop();
    completed = stopped.status !== "incomplete";
    return stopped;
  } finally {
    if (!completed) await stopTestChild(owner.launch.process);
  }
};
