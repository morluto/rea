import { describe, expect, it, vi } from "vitest";
import {
  cleanupOwnedProcessGroup,
  type ProcessOwnershipHost,
} from "./ProcessOwnership.js";
import { parseProcessEnvironment } from "./ProcessOwnershipObservation.js";
import { selectCapturedProcessGroupIds } from "./ProcessOwnershipProcessTree.js";
import { matchesOwnedProcessCommand } from "./ProcessCommandIdentity.js";
const ownership = {
  runId: "run-token",
  leaderPid: 100,
  processGroupId: 100,
};
const host = (
  environments: Readonly<Record<number, Readonly<Record<string, string>>>>,
): {
  readonly adapter: ProcessOwnershipHost;
  readonly signalGroup: ReturnType<typeof vi.fn>;
} => {
  const signalGroup = vi.fn();
  return {
    adapter: {
      listProcesses: () =>
        Promise.resolve(
          Object.keys(environments).map((pid) => ({
            pid: Number(pid),
            parentPid: Number(pid) === 100 ? 1 : 100,
            processGroupId: 100,
            state: "S",
            command: "fixture",
          })),
        ),
      environment: (pid) => Promise.resolve(environments[pid] ?? {}),
      signalGroup,
    },
    signalGroup,
  };
};
describe("owned process-group cleanup discovery", () => {
  it("excludes sampled groups whose leader was outside the captured tree", () => {
    expect(
      selectCapturedProcessGroupIds(100, [
        { pid: 100, process_group_id: 42 },
        { pid: 100, process_group_id: 100 },
        { pid: 101, process_group_id: 42 },
        { pid: 102, process_group_id: 102 },
        { pid: 103, process_group_id: 102 },
      ]),
    ).toEqual([100, 102]);
  });
  it("drops nameless Linux environment entries", () => {
    expect(
      parseProcessEnvironment("=ignored\0REA_PROCESS_RUN_ID=owned\0EMPTY=\0"),
    ).toEqual({ REA_PROCESS_RUN_ID: "owned", EMPTY: "" });
  });
  it("matches macOS executable names after process-table normalization", () => {
    expect(
      matchesOwnedProcessCommand(
        "node /tmp/fake-launcher.mjs",
        "/opt/node/bin/node",
        "darwin",
      ),
    ).toBe(true);
    expect(
      matchesOwnedProcessCommand("(node)", "/opt/node/bin/node", "darwin"),
    ).toBe(true);
    expect(
      matchesOwnedProcessCommand(
        "node /tmp/fake-launcher.mjs",
        "/opt/python/bin/python3",
        "darwin",
      ),
    ).toBe(false);
    expect(
      matchesOwnedProcessCommand(
        "node /tmp/fake-launcher.mjs",
        "/opt/node/bin/node",
        "linux",
      ),
    ).toBe(false);
    expect(
      matchesOwnedProcessCommand("(node)", "/opt/node/bin/node", "linux"),
    ).toBe(false);
  });
  it("signals only a group whose every member carries the run token", async () => {
    const { adapter, signalGroup } = host({
      100: { REA_PROCESS_RUN_ID: "run-token" },
      101: { REA_PROCESS_RUN_ID: "run-token" },
    });
    expect(await cleanupOwnedProcessGroup(ownership, adapter)).toEqual({
      cleaned: true,
      signaled: true,
    });
    expect(signalGroup).toHaveBeenCalledWith(100, "SIGKILL");
  });
});

describe("opaque process neighbors during cleanup", () => {
  it("cleans verified run-owned groups while reporting an opaque neighbor", async () => {
    const processes = [
      { pid: 100, parentPid: 1, processGroupId: 100, command: "capture" },
      {
        pid: 200,
        parentPid: 1,
        processGroupId: 200,
        command: "detached-child",
      },
      {
        pid: 900,
        parentPid: 1,
        processGroupId: 900,
        command: "opaque-neighbor",
      },
    ].map((process) => ({ ...process, state: "S" }));
    const signalGroup = vi.fn();
    const identities = new Map(
      processes.map(({ pid }) => [
        pid,
        { state: "readable" as const, identity: `start-${String(pid)}` },
      ]),
    );
    const adapter: ProcessOwnershipHost = {
      listProcesses: () => Promise.resolve(processes),
      environment: (pid) =>
        Promise.resolve({
          REA_PROCESS_RUN_ID: pid === 900 ? "unowned" : "run-token",
        }),
      processIdentities: () => Promise.resolve(identities),
      runTokens: (members) =>
        Promise.resolve(
          new Map(
            members.map(({ pid }) => [
              pid,
              pid === 900
                ? {
                    state: "unavailable" as const,
                    reason: "environment_unavailable",
                  }
                : { state: "readable" as const, runId: "run-token" },
            ]),
          ),
        ),
      signalGroup,
    };

    const result = await cleanupOwnedProcessGroup(
      {
        ...ownership,
        sweepTokenOwnedProcesses: true,
        captureBaseline: [],
      },
      adapter,
    );

    expect(result).toMatchObject({
      cleaned: false,
      reason: expect.stringContaining("environment_unavailable=1"),
    });
    expect(signalGroup.mock.calls).toEqual([
      [100, "SIGKILL"],
      [200, "SIGKILL"],
    ]);
    expect(signalGroup).not.toHaveBeenCalledWith(900, "SIGKILL");
  });
});

describe("sampled detached process groups during cleanup", () => {
  it("signals only token-authenticated sampled groups and reports an unowned sample", async () => {
    const processes = [
      {
        pid: 100,
        parentPid: 1,
        processGroupId: 100,
        state: "S",
        command: "capture",
      },
      {
        pid: 200,
        parentPid: 1,
        processGroupId: 200,
        state: "S",
        command: "sanitized-detached-child",
      },
    ];
    const signalGroup = vi.fn();
    const identities = new Map([
      [100, { state: "readable" as const, identity: "start-100" }],
      [200, { state: "readable" as const, identity: "start-200" }],
    ]);
    const adapter: ProcessOwnershipHost = {
      listProcesses: () => Promise.resolve(processes),
      environment: (pid) =>
        Promise.resolve(pid === 100 ? { REA_PROCESS_RUN_ID: "run-token" } : {}),
      processIdentities: () => Promise.resolve(identities),
      runTokens: (members) =>
        Promise.resolve(
          new Map(
            members.map(({ pid }) => [
              pid,
              {
                state: "readable" as const,
                runId: pid === 100 ? "run-token" : undefined,
              },
            ]),
          ),
        ),
      signalGroup,
    };

    const result = await cleanupOwnedProcessGroup(
      {
        ...ownership,
        sweepTokenOwnedProcesses: true,
        sampledProcessGroupIds: [200],
      },
      adapter,
    );

    expect(result).toMatchObject({
      cleaned: false,
      reason: "process tree contains an unowned or PID-reused process",
      failures: [{ pid: 200, reason: "run-token-mismatch" }],
    });
    expect(signalGroup).toHaveBeenCalledTimes(1);
    expect(signalGroup).toHaveBeenCalledWith(100, "SIGKILL");
    expect(signalGroup).not.toHaveBeenCalledWith(200, "SIGKILL");
  });

  it("reports a live sampled group after the launcher has exited without signaling it", async () => {
    const process = {
      pid: 200,
      parentPid: 1,
      processGroupId: 200,
      state: "S",
      command: "sanitized-detached-child",
    };
    const signalGroup = vi.fn();
    const adapter: ProcessOwnershipHost = {
      listProcesses: () => Promise.resolve([process]),
      environment: () => Promise.resolve({}),
      runTokens: () =>
        Promise.resolve(
          new Map([[200, { state: "readable" as const, runId: undefined }]]),
        ),
      signalGroup,
    };

    const result = await cleanupOwnedProcessGroup(
      {
        ...ownership,
        sweepTokenOwnedProcesses: true,
        sampledProcessGroupIds: [200],
      },
      adapter,
    );

    expect(result).toMatchObject({
      cleaned: false,
      reason: "process tree contains an unowned or PID-reused process",
      failures: [{ pid: 200, reason: "run-token-mismatch" }],
    });
    expect(signalGroup).not.toHaveBeenCalled();
  });
});

describe("rooted process-group cleanup", () => {
  it("validates and signals rooted descendant groups once, root first", async () => {
    const processes = [
      { pid: 100, parentPid: 1, processGroupId: 100 },
      { pid: 110, parentPid: 100, processGroupId: 100 },
      { pid: 101, parentPid: 100, processGroupId: 101 },
      { pid: 102, parentPid: 101, processGroupId: 102 },
      { pid: 103, parentPid: 102, processGroupId: 102 },
    ].map((process) => ({
      ...process,
      state: "S",
      command: "fixture",
    }));
    const signalGroup = vi.fn();
    const adapter: ProcessOwnershipHost = {
      listProcesses: () => Promise.resolve(processes),
      environment: () => Promise.resolve({ REA_PROCESS_RUN_ID: "run-token" }),
      signalGroup,
    };
    await expect(cleanupOwnedProcessGroup(ownership, adapter)).resolves.toEqual(
      { cleaned: true, signaled: true },
    );
    expect(signalGroup.mock.calls).toEqual([
      [100, "SIGKILL"],
      [101, "SIGKILL"],
      [102, "SIGKILL"],
    ]);
  });
  it("leaves an unrelated Hopper process group outside the rooted tree untouched", async () => {
    const processes = [
      { pid: 100, parentPid: 1, processGroupId: 100, command: "rea-hopper" },
      { pid: 101, parentPid: 100, processGroupId: 101, command: "owned-child" },
      {
        pid: 900,
        parentPid: 1,
        processGroupId: 900,
        command:
          "/Applications/Hopper Disassembler.app/Contents/MacOS/Hopper Disassembler",
      },
    ].map((process) => ({ ...process, state: "S" }));
    const environment = vi.fn((pid: number) =>
      Promise.resolve({
        REA_PROCESS_RUN_ID: pid === 900 ? "unrelated-run" : "run-token",
      }),
    );
    const signalGroup = vi.fn();
    const adapter: ProcessOwnershipHost = {
      listProcesses: () => Promise.resolve(processes),
      environment,
      signalGroup,
    };
    await expect(cleanupOwnedProcessGroup(ownership, adapter)).resolves.toEqual(
      { cleaned: true, signaled: true },
    );
    expect(signalGroup.mock.calls).toEqual([
      [100, "SIGKILL"],
      [101, "SIGKILL"],
    ]);
    expect(environment.mock.calls.some(([pid]) => pid === 900)).toBe(false);
  });
});
