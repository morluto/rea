import { describe, expect, it, vi } from "vitest";
import {
  cleanupOwnedProcessGroup,
  verifyNoTokenOwnedProcesses,
  type ProcessOwnershipHost,
  type ProcessTableEntry,
} from "./ProcessOwnership.js";
import { createSystemProcessOwnershipHost } from "./ProcessOwnershipObservation.js";

describe("capture-local process identity baselines", () => {
  it("does not require Darwin identity inspection from a Linux system host", () => {
    const host = createSystemProcessOwnershipHost("linux", {});
    expect(host.processIdentities).toBeUndefined();
    expect(host.captureBaseline).toBeUndefined();
  });

  it("validates and cleans an exact-token owner without a capture baseline", async () => {
    const process: ProcessTableEntry = {
      pid: 904,
      parentPid: 1,
      processGroupId: 904,
      state: "S",
      command: "generic-darwin-owner",
    };
    const signalGroup = vi.fn();
    const host: ProcessOwnershipHost = {
      listProcesses: () => Promise.resolve([process]),
      environment: () => Promise.resolve({ REA_PROCESS_RUN_ID: "run-token" }),
      runTokens: (entries) =>
        Promise.resolve(
          new Map(
            entries.map(({ pid }) => [
              pid,
              { state: "readable", runId: "run-token" } as const,
            ]),
          ),
        ),
      processIdentities: (entries) =>
        Promise.resolve(
          new Map(
            entries.map(({ pid }) => [
              pid,
              { state: "readable", identity: "owner-start" } as const,
            ]),
          ),
        ),
      signalGroup,
    };

    await expect(
      cleanupOwnedProcessGroup(
        {
          runId: "run-token",
          leaderPid: process.pid,
          processGroupId: process.processGroupId,
          sweepTokenOwnedProcesses: true,
        },
        host,
      ),
    ).resolves.toEqual({ cleaned: true, signaled: true });
    expect(signalGroup).toHaveBeenCalledWith(process.processGroupId, "SIGKILL");
  });

  it("cleans verified owners before reporting an unrelated opaque process", async () => {
    const owned: ProcessTableEntry = {
      pid: 905,
      parentPid: 1,
      processGroupId: 905,
      state: "S",
      command: "owned-detached-child",
    };
    const opaque: ProcessTableEntry = {
      pid: 906,
      parentPid: 1,
      processGroupId: 906,
      state: "S",
      command: "unrelated-process",
    };
    const malformed: ProcessTableEntry = {
      ...opaque,
      pid: 907,
      processGroupId: 907,
      command: "malformed-procargs-process",
    };
    const sysctlDenied: ProcessTableEntry = {
      ...opaque,
      pid: 908,
      processGroupId: 908,
      command: "sysctl-denied-process",
    };
    const signalGroup = vi.fn();
    const host: ProcessOwnershipHost = {
      listProcesses: () =>
        Promise.resolve([owned, opaque, malformed, sysctlDenied]),
      environment: (pid) =>
        pid === owned.pid
          ? Promise.resolve({ REA_PROCESS_RUN_ID: "run-token" })
          : Promise.reject(new Error("permission denied")),
      runTokens: (entries) =>
        Promise.resolve(
          new Map(
            entries.map(({ pid }) => [
              pid,
              pid === owned.pid
                ? { state: "readable", runId: "run-token" as const }
                : {
                    state: "unavailable",
                    reason:
                      pid === malformed.pid
                        ? ("malformed_procargs" as const)
                        : pid === sysctlDenied.pid
                          ? ("sysctl_failed_1" as const)
                          : ("environment_unavailable" as const),
                  },
            ]),
          ),
        ),
      signalGroup,
    };

    await expect(
      cleanupOwnedProcessGroup(
        {
          runId: "run-token",
          leaderPid: 100,
          processGroupId: 100,
          sweepTokenOwnedProcesses: true,
        },
        host,
      ),
    ).resolves.toMatchObject({
      cleaned: false,
      reason:
        "process ownership token could not be read for 3 live process(es): environment_unavailable=1, malformed_procargs=1, sysctl_errno_1=1",
    });
    expect(signalGroup).toHaveBeenCalledWith(owned.processGroupId, "SIGKILL");
    expect(signalGroup).not.toHaveBeenCalledWith(
      opaque.processGroupId,
      "SIGKILL",
    );
    expect(signalGroup).not.toHaveBeenCalledWith(
      malformed.processGroupId,
      "SIGKILL",
    );
    expect(signalGroup).not.toHaveBeenCalledWith(
      sysctlDenied.processGroupId,
      "SIGKILL",
    );
  });
});

describe("capture-local process identity baselines", () => {
  it("checks reused and unknown PIDs while skipping unchanged identities", async () => {
    const tokenReads: number[][] = [];
    const processes: readonly ProcessTableEntry[] = [
      {
        pid: 899,
        parentPid: 1,
        processGroupId: 899,
        state: "S",
        command: "stable",
      },
      {
        pid: 900,
        parentPid: 1,
        processGroupId: 900,
        state: "S",
        command: "reused",
      },
      {
        pid: 902,
        parentPid: 1,
        processGroupId: 902,
        state: "S",
        command: "unknown",
      },
    ];
    const host: ProcessOwnershipHost = {
      listProcesses: () => Promise.resolve(processes),
      environment: () => Promise.resolve({}),
      processIdentities: (entries) =>
        Promise.resolve(
          new Map(
            entries.map(({ pid }) => [
              pid,
              pid === 902
                ? { state: "unavailable", reason: "fixture" }
                : {
                    state: "readable",
                    identity: pid === 899 ? "stable-start" : "reused-start",
                  },
            ]),
          ),
        ),
      runTokens: (entries) => {
        tokenReads.push(entries.map(({ pid }) => pid));
        return Promise.resolve(
          new Map(
            entries.map(({ pid }) => [
              pid,
              {
                state: "readable",
                runId: pid === 900 ? "run-token" : undefined,
              },
            ]),
          ),
        );
      },
      signalGroup: vi.fn(),
    };

    await expect(
      verifyNoTokenOwnedProcesses("run-token", host, [
        { pid: 899, identity: "stable-start" },
        { pid: 900, identity: "old-start" },
        { pid: 902, identity: null },
      ]),
    ).resolves.toEqual({
      cleaned: false,
      reason: "token-owned process remained after cleanup",
    });
    expect(tokenReads).toEqual([[900, 902]]);
  });

  it("refuses to signal when PID identity changes after token validation", async () => {
    const signalGroup = vi.fn();
    let identityReads = 0;
    const process: ProcessTableEntry = {
      pid: 903,
      parentPid: 1,
      processGroupId: 903,
      state: "S",
      command: "reused-before-signal",
    };
    const host: ProcessOwnershipHost = {
      listProcesses: () => Promise.resolve([process]),
      environment: () => Promise.resolve({ REA_PROCESS_RUN_ID: "run-token" }),
      processIdentities: (entries) => {
        identityReads += 1;
        const identity = identityReads < 3 ? "owned-start" : "reused-start";
        return Promise.resolve(
          new Map(
            entries.map(({ pid }) => [
              pid,
              { state: "readable", identity } as const,
            ]),
          ),
        );
      },
      runTokens: (entries) =>
        Promise.resolve(
          new Map(
            entries.map(({ pid }) => [
              pid,
              { state: "readable", runId: "run-token" } as const,
            ]),
          ),
        ),
      signalGroup,
    };

    await expect(
      cleanupOwnedProcessGroup(
        {
          runId: "run-token",
          leaderPid: 100,
          processGroupId: 100,
          sweepTokenOwnedProcesses: true,
          captureBaseline: [{ pid: process.pid, identity: "old-start" }],
        },
        host,
      ),
    ).resolves.toMatchObject({
      cleaned: false,
      reason: "process identity could not be revalidated",
    });
    expect(signalGroup).not.toHaveBeenCalled();
    expect(identityReads).toBeGreaterThanOrEqual(3);
  });
});
