import { describe, expect, it, vi } from "vitest";
import {
  cleanupOwnedProcessGroup,
  cleanupWindowsProcessTree,
  observeOwnedProcessGroup,
  parseProcessEnvironment,
  selectCapturedProcessGroupIds,
  type ProcessOwnershipHost,
  type WindowsProcessTreeHost,
} from "../src/process/ProcessOwnership.js";

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
      listMembers: () =>
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

describe("owned process-group cleanup", () => {
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

  it("fails closed for stale metadata or an unrelated concurrent process", async () => {
    const { adapter, signalGroup } = host({
      100: { REA_PROCESS_RUN_ID: "run-token" },
      101: { REA_PROCESS_RUN_ID: "different-run" },
    });
    expect(await cleanupOwnedProcessGroup(ownership, adapter)).toEqual({
      cleaned: false,
      reason: "process group contains an unowned or PID-reused process",
      failures: [{ pid: 101, reason: "run-token-mismatch" }],
    });
    expect(signalGroup).not.toHaveBeenCalled();
  });

  it("checks every member and aggregates ownership read failures", async () => {
    const environment = vi.fn((pid: number) => {
      if (pid === 100)
        return Promise.reject(new Error("transient procfs read"));
      return Promise.resolve(
        pid === 101
          ? { REA_PROCESS_RUN_ID: "different-run" }
          : { REA_PROCESS_RUN_ID: "run-token" },
      );
    });
    const signalGroup = vi.fn();
    const adapter: ProcessOwnershipHost = {
      listMembers: () =>
        Promise.resolve(
          [100, 101, 102].map((pid) => ({
            pid,
            parentPid: pid === 100 ? 1 : 100,
            processGroupId: 100,
            state: "S",
            command: "fixture",
          })),
        ),
      environment,
      signalGroup,
    };

    expect(await cleanupOwnedProcessGroup(ownership, adapter)).toEqual({
      cleaned: false,
      reason: "process group contains an unowned or PID-reused process",
      failures: [
        { pid: 100, reason: "environment-unreadable" },
        { pid: 101, reason: "run-token-mismatch" },
      ],
    });
    expect(environment.mock.calls.map(([pid]) => pid)).toEqual([100, 101, 102]);
    expect(signalGroup).not.toHaveBeenCalled();
  });

  it("ignores exited zombie members during live ownership checks", async () => {
    const environment = vi.fn((pid: number) =>
      Promise.resolve(pid === 101 ? {} : { REA_PROCESS_RUN_ID: "run-token" }),
    );
    const signalGroup = vi.fn();
    const adapter: ProcessOwnershipHost = {
      listMembers: () =>
        Promise.resolve([
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
            processGroupId: 100,
            state: "Z",
            command: "[node] <defunct>",
          },
        ]),
      environment,
      signalGroup,
    };

    expect(await cleanupOwnedProcessGroup(ownership, adapter)).toEqual({
      cleaned: true,
      signaled: true,
    });
    expect(environment).toHaveBeenCalledTimes(1);
    expect(environment).toHaveBeenCalledWith(100);
    expect(signalGroup).toHaveBeenCalledWith(100, "SIGKILL");
  });

  it("observes a zombie-only group as settled", async () => {
    const environment = vi.fn(() => Promise.resolve({}));
    const adapter: ProcessOwnershipHost = {
      listMembers: () =>
        Promise.resolve([
          {
            pid: 101,
            parentPid: 1,
            processGroupId: 100,
            state: "Z+",
            command: "[node] <defunct>",
          },
        ]),
      environment,
      signalGroup: vi.fn(),
    };

    expect(await observeOwnedProcessGroup(ownership, adapter)).toEqual({
      state: "empty",
    });
    expect(environment).not.toHaveBeenCalled();
  });

  it("is idempotent when the owned group has already exited", async () => {
    const { adapter } = host({});
    expect(await cleanupOwnedProcessGroup(ownership, adapter)).toEqual({
      cleaned: true,
      signaled: false,
    });
  });

  it("fails closed when the launcher command identity changes", async () => {
    const { adapter, signalGroup } = host({
      100: { REA_PROCESS_RUN_ID: "run-token" },
    });
    expect(
      await cleanupOwnedProcessGroup(
        {
          ...ownership,
          expectedCommand: "/owned/hopper",
          expectedParentPid: 1,
        },
        adapter,
      ),
    ).toEqual({
      cleaned: false,
      reason: "owned launcher command identity did not match",
    });
    expect(signalGroup).not.toHaveBeenCalled();
  });

  it("fails closed when the launcher parent identity changes", async () => {
    const { adapter, signalGroup } = host({
      100: { REA_PROCESS_RUN_ID: "run-token" },
    });
    expect(
      await cleanupOwnedProcessGroup(
        { ...ownership, expectedCommand: "fixture", expectedParentPid: 999 },
        adapter,
      ),
    ).toEqual({
      cleaned: false,
      reason: "owned launcher parent identity did not match",
    });
    expect(signalGroup).not.toHaveBeenCalled();
  });
});

describe("Windows P0 process-tree cleanup", () => {
  it("reports whether taskkill signaled or found an exited tree", async () => {
    const terminated: WindowsProcessTreeHost = {
      terminateTree: () => Promise.resolve("terminated"),
    };
    const missing: WindowsProcessTreeHost = {
      terminateTree: () => Promise.resolve("missing"),
    };

    await expect(cleanupWindowsProcessTree(42, terminated)).resolves.toEqual({
      cleaned: true,
      signaled: true,
    });
    await expect(cleanupWindowsProcessTree(42, missing)).resolves.toEqual({
      cleaned: true,
      signaled: false,
    });
  });

  it("keeps invalid identity and termination failures explicit", async () => {
    const failing: WindowsProcessTreeHost = {
      terminateTree: () => Promise.reject(new Error("taskkill failed")),
    };

    await expect(cleanupWindowsProcessTree(0, failing)).resolves.toEqual({
      cleaned: false,
      reason: "Windows process-tree PID is invalid",
    });
    await expect(cleanupWindowsProcessTree(42, failing)).resolves.toEqual({
      cleaned: false,
      reason:
        "Windows P0 process-tree termination failed; Job Object ownership is unavailable",
    });
  });
});
