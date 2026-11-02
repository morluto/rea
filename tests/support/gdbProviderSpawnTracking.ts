import {
  cleanupOwnedProcessGroup,
  type OwnedProcessGroup,
} from "../../src/process/ProcessOwnership.js";
import {
  spawnOwnedProviderProcess,
  type OwnedProviderProcessSpawnOptions,
  type SpawnedOwnedProviderProcess,
} from "../../src/process/ProviderProcess.js";

/**
 * Track real fake-provider children so a test that intentionally retains debugger
 * ownership cannot leak the process it spawned into the developer's machine.
 *
 * Survivors are signalled through their retained ownership, which revalidates the
 * capture run token before every signal: a PID that an unrelated process reused
 * after exit is never signalled. An ownership whose cleanup cannot be verified
 * stays retained and is reported instead of being dropped.
 */
export const createProviderSpawnTracker = (
  cleanupOwned: typeof cleanupOwnedProcessGroup = cleanupOwnedProcessGroup,
): {
  readonly spawnProcess: (
    options: OwnedProviderProcessSpawnOptions,
  ) => Promise<SpawnedOwnedProviderProcess>;
  readonly killSurvivors: () => Promise<readonly string[]>;
} => {
  const ownerships: OwnedProcessGroup[] = [];
  return {
    spawnProcess: async (options) => {
      // These fixtures are interpreter-driven launch scripts, so the observed
      // argv prefix is the interpreter rather than the selected command.
      const spawned = await spawnOwnedProviderProcess({
        ...options,
        expectedCommand: null,
      });
      ownerships.push(spawned.ownership);
      return spawned;
    },
    killSurvivors: async () => {
      const pending = ownerships.splice(0);
      const unresolved: string[] = [];
      for (const ownership of pending) {
        const result = await cleanupOwned(ownership);
        if (result.cleaned === true) continue;
        unresolved.push(`${ownership.runId}: ${result.reason}`);
        ownerships.push(ownership);
      }
      return unresolved;
    },
  };
};
