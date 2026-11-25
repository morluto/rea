import { expect, it, vi } from "vitest";
import type { ProcessOwnershipHost } from "./ProcessOwnership.js";
import { ProcessOwnershipInspectionCancelled } from "./ProcessInspectionCancellation.js";
import {
  createSystemProcessOwnershipHost,
  LinuxOwnedProcessPrerequisiteError,
} from "./ProcessOwnershipObservation.js";
import { spawnOwnedProviderProcess } from "./ProviderProcess.js";

const posixIt = it.skipIf(process.platform === "win32");

const inspectionHost = () =>
  ({
    platform: "linux" as const,
    prepare: vi.fn(async (_signal?: AbortSignal) => undefined),
    captureBaseline: vi.fn(async (_signal?: AbortSignal) => [
      { pid: process.pid, identity: "selected-host-baseline" },
    ]),
    listProcesses: vi.fn(async () => []),
    environment: vi.fn(async () => ({})),
    signalGroup: vi.fn(),
  }) satisfies ProcessOwnershipHost;

posixIt(
  "keeps selected ownership admission, baseline and cleanup on the same host",
  async () => {
    const host = inspectionHost();
    const controller = new AbortController();
    const launched = await spawnOwnedProviderProcess({
      command: process.execPath,
      arguments: ["-e", "process.exit(0)"],
      runId: "selected-ownership-host",
      ownershipHost: host,
      sweepTokenOwnedProcesses: true,
      signal: controller.signal,
    });
    // Wait for the real short-lived child before asking the modeled empty host
    // table for cleanup proof. No live fixture is hidden by this seam.
    if (
      launched.process.exitCode === null &&
      launched.process.signalCode === null
    )
      await new Promise<void>((resolve) => {
        launched.process.once("exit", () => resolve());
      });
    expect(host.prepare).toHaveBeenCalledExactlyOnceWith(controller.signal);
    expect(host.captureBaseline).toHaveBeenCalledExactlyOnceWith(
      controller.signal,
    );
    expect(launched.ownership.captureBaseline).toEqual([
      { pid: process.pid, identity: "selected-host-baseline" },
    ]);
    const refused = new Error("selected inspection unavailable during cleanup");
    host.listProcesses.mockRejectedValueOnce(refused);
    expect(await launched.cleanup?.()).toMatchObject({ cleaned: false });
    expect(host.listProcesses).toHaveBeenCalledTimes(1);
    expect(await launched.cleanup?.()).toMatchObject({ cleaned: true });
    // Successful token-sweep cleanup obtains and then verifies an empty table.
    expect(host.listProcesses).toHaveBeenCalledTimes(3);
    expect(host.signalGroup).not.toHaveBeenCalled();
  },
);

posixIt.each(["prepare", "captureBaseline"] as const)(
  "preserves the selected host's %s failure before spawning",
  async (stage) => {
    const host = inspectionHost();
    const failure = new Error(`selected ${stage} failed`);
    host[stage].mockRejectedValueOnce(failure);
    await expect(
      spawnOwnedProviderProcess({
        // Any accidental launch fails differently, rather than leaking a child.
        command: "/nonexistent-rea-selected-host-fixture",
        arguments: [],
        runId: "selected-host-refusal",
        ownershipHost: host,
        sweepTokenOwnedProcesses: true,
      }),
    ).rejects.toBe(failure);
    expect(host.prepare).toHaveBeenCalledOnce();
    expect(host.captureBaseline).toHaveBeenCalledTimes(
      stage === "prepare" ? 0 : 1,
    );
    expect(host.listProcesses).not.toHaveBeenCalled();
  },
);

posixIt.each(["before-admission", "prepare", "captureBaseline"] as const)(
  "honors cancellation at selected-host %s without spawning",
  async (stage) => {
    const host = inspectionHost();
    const controller = new AbortController();
    const reason = new Error("caller cancelled selected inspection");
    if (stage === "before-admission") controller.abort(reason);
    else if (stage === "prepare")
      host.prepare.mockImplementationOnce(async () => {
        controller.abort(reason);
      });
    else
      host.captureBaseline.mockImplementationOnce(async () => {
        controller.abort(reason);
        return [];
      });
    const failure = await spawnOwnedProviderProcess({
      command: "/nonexistent-rea-selected-host-fixture",
      arguments: [],
      runId: "selected-host-cancellation",
      ownershipHost: host,
      sweepTokenOwnedProcesses: true,
      signal: controller.signal,
    }).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(ProcessOwnershipInspectionCancelled);
    expect(failure).toMatchObject({ reason, cause: reason });
    expect(host.prepare).toHaveBeenCalledTimes(
      stage === "before-admission" ? 0 : 1,
    );
    expect(host.captureBaseline).toHaveBeenCalledTimes(
      stage === "captureBaseline" ? 1 : 0,
    );
    expect(host.listProcesses).not.toHaveBeenCalled();
  },
);

it.runIf(process.platform === "linux")(
  "uses the selected host's process-table budget rather than the child environment at admission",
  async () => {
    const host = createSystemProcessOwnershipHost("linux", {
      ...process.env,
      REA_PROCESS_TABLE_MAX_BYTES: "1",
    });
    try {
      const failure = await spawnOwnedProviderProcess({
        command: "/nonexistent-rea-selected-host-fixture",
        arguments: [],
        runId: "selected-host-budget",
        ownershipHost: host,
        hostEnvironment: {
          ...process.env,
          REA_PROCESS_TABLE_MAX_BYTES: "8388608",
        },
        signal: AbortSignal.timeout(2_000),
      }).catch((cause: unknown) => cause);
      expect(failure).toBeInstanceOf(LinuxOwnedProcessPrerequisiteError);
      expect(failure).toMatchObject({ outputLimitBytes: 1 });
    } finally {
      await host.close?.();
    }
  },
);

posixIt(
  "preserves caller-owned cleanup when no inspection host is selected",
  async () => {
    const launched = await spawnOwnedProviderProcess({
      command: process.execPath,
      arguments: ["-e", "process.exit(0)"],
      runId: "default-caller-owned-cleanup",
    });
    if (
      launched.process.exitCode === null &&
      launched.process.signalCode === null
    )
      await new Promise<void>((resolve) =>
        launched.process.once("exit", () => resolve()),
      );
    expect(launched.cleanup).toBeUndefined();
  },
);
