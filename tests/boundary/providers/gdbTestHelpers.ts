import {
  ProviderProcessSupervisor,
  spawnOwnedProviderProcess,
} from "../../../src/process/ProviderProcess.js";
import { OwnedDebuggerCleanupError } from "../../../src/process/ownedDebuggerCleanupError.js";
import { expect } from "vitest";

import type { GdbSessionManager } from "../../../src/gdb/GdbSessionManager.js";

type GdbSessionStart = Awaited<ReturnType<GdbSessionManager["start"]>>;
type StartedGdbSession = Extract<GdbSessionStart, { readonly ok: true }>;

export const expectGdbSessionStarted = async (
  manager: GdbSessionManager,
  ...arguments_: Parameters<GdbSessionManager["start"]>
): Promise<StartedGdbSession> => {
  const started = await manager.start(...arguments_);
  expect(started.ok).toBe(true);
  if (!started.ok) throw new Error(started.error.message);
  return started;
};

/** The fixture, unlike GDB, knows these inert provider processes have no real inferior. */
export const createGdbFixtureOwner = (
  controls: {
    readonly stopOwnedProcess?: (
      supervisor: ProviderProcessSupervisor,
    ) => ReturnType<ProviderProcessSupervisor["stop"]>;
  } = {},
) => {
  const processes = new Set<ProviderProcessSupervisor>();
  const spawnProcess: typeof spawnOwnedProviderProcess = async (options) => {
    const launched = await spawnOwnedProviderProcess(options);
    processes.add(
      new ProviderProcessSupervisor(
        { ...launched, ownsProcessLifetime: true },
        { captureStdout: false, maxDiagnosticBytes: 0 },
      ),
    );
    return launched;
  };
  const cleanup = async (
    managers: Array<{ closeAll(): Promise<void> }>,
    removeFiles: () => Promise<void>,
  ): Promise<void> => {
    const outcomes = await Promise.allSettled(
      managers.map((manager) => manager.closeAll()),
    );
    // The tests intentionally model unknown inferior state. Only that tagged
    // refusal is discharged by the fixture's independent physical process owner.
    const failures = outcomes.flatMap((outcome) =>
      outcome.status === "rejected" &&
      !(outcome.reason instanceof OwnedDebuggerCleanupError)
        ? [outcome.reason as unknown]
        : [],
    );
    for (const supervisor of processes) {
      try {
        const result =
          controls.stopOwnedProcess === undefined
            ? await supervisor.stop()
            : await controls.stopOwnedProcess(supervisor);
        if (result.status === "incomplete")
          throw new Error(`Fake GDB cleanup incomplete: ${result.reason}`);
        if (supervisor.observedExit() === undefined)
          throw new Error("Fake GDB cleanup did not observe child exit");
        processes.delete(supervisor);
      } catch (cause: unknown) {
        failures.push(cause);
      }
    }
    if (failures.length > 0)
      throw new AggregateError(failures, "Fake GDB fixture cleanup failed");
    managers.length = 0;
    await removeFiles();
  };
  return { spawnProcess, cleanup };
};
