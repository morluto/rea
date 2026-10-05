import { describe, expect, it, vi } from "vitest";
import { type ProcessOwnershipHost } from "./ProcessOwnership.js";
import { observeOwnedProcessLineage } from "./ProcessOwnershipObservation.js";
const ownership = {
  runId: "run-token",
  leaderPid: 100,
  processGroupId: 100,
};
describe("owned process-group cleanup discovery", () => {
  it("walks the PPID tree across process-group boundaries", async () => {
    const environment = vi.fn((pid: number) =>
      Promise.resolve({
        REA_PROCESS_RUN_ID: pid === 103 ? "unrelated-run" : "run-token",
      }),
    );
    const adapter: ProcessOwnershipHost = {
      listProcesses: () =>
        Promise.resolve([
          {
            pid: 103,
            parentPid: 999,
            processGroupId: 100,
            state: "S",
            command: "unrelated-same-group",
          },
          {
            pid: 102,
            parentPid: 101,
            processGroupId: 102,
            state: "S",
            command: "grandchild-session",
          },
          {
            pid: 100,
            parentPid: 1,
            processGroupId: 100,
            state: "S",
            command: "fixture",
          },
          {
            pid: 101,
            parentPid: 100,
            processGroupId: 101,
            state: "S",
            command: "child-group",
          },
        ]),
      environment,
      signalGroup: vi.fn(),
    };
    await expect(
      observeOwnedProcessLineage(ownership, adapter),
    ).resolves.toEqual({
      status: "verified",
      observedAt: expect.any(String),
      lineage: {
        runId: "run-token",
        launcherPid: 100,
        launcherParentPid: 1,
        processGroupId: 100,
        descendants: [
          { pid: 101, parentPid: 100, processGroupId: 101 },
          { pid: 102, parentPid: 101, processGroupId: 102 },
        ],
      },
    });
  });
  it("omits a descendant that exits while lineage is validated", async () => {
    const launcher = {
      pid: 100,
      parentPid: 1,
      processGroupId: 100,
      state: "S",
      command: "root",
    };
    const child = {
      pid: 101,
      parentPid: 100,
      processGroupId: 101,
      state: "S",
      command: "child",
    };
    const processes = [launcher, child];
    const listProcesses = vi
      .fn<ProcessOwnershipHost["listProcesses"]>()
      .mockResolvedValueOnce(processes)
      .mockResolvedValueOnce([launcher]);
    const host: ProcessOwnershipHost = {
      listProcesses,
      environment: (pid) =>
        pid === 101
          ? Promise.reject(new Error("process exited during environment read"))
          : Promise.resolve({ REA_PROCESS_RUN_ID: "run-token" }),
      signalGroup: vi.fn(),
    };

    await expect(observeOwnedProcessLineage(ownership, host)).resolves.toEqual({
      status: "verified",
      observedAt: expect.any(String),
      lineage: {
        runId: "run-token",
        launcherPid: 100,
        launcherParentPid: 1,
        processGroupId: 100,
        descendants: [],
      },
    });
  });

  it("does not publish lineage when the launcher exits during validation", async () => {
    const launcher = {
      pid: 100,
      parentPid: 1,
      processGroupId: 100,
      state: "S",
      command: "root",
    };
    const listProcesses = vi
      .fn<ProcessOwnershipHost["listProcesses"]>()
      .mockResolvedValueOnce([launcher])
      .mockResolvedValueOnce([]);
    const host: ProcessOwnershipHost = {
      listProcesses,
      environment: () => Promise.reject(new Error("launcher exited")),
      signalGroup: vi.fn(),
    };

    await expect(
      observeOwnedProcessLineage(ownership, host),
    ).resolves.toMatchObject({
      status: "unavailable",
      reason: "owned launcher exited during lineage validation",
    });
  });
});
