import { describe, expect, it, vi } from "vitest";
import {
  observeOwnedProcessLineage,
  type ProcessOwnershipHost,
} from "./ProcessOwnership.js";
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
        schemaVersion: 1,
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
    expect(environment.mock.calls.map(([pid]) => pid)).toEqual([100, 101, 102]);
  });
});
