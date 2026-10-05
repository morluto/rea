import { describe, expect, it, vi } from "vitest";
import {
  cleanupOwnedProcessGroup,
  cleanupWindowsProcessTree,
  type ProcessOwnershipHost,
  type WindowsProcessTreeHost,
} from "./ProcessOwnership.js";
import {
  createSystemProcessOwnershipHost,
  observeOwnedProcessGroup,
  observeOwnedProcessLineage,
} from "./ProcessOwnershipObservation.js";
import { host, ownership } from "./ProcessOwnership.fixture.js";

describe("owned process-group cleanup validation: ownership and lineage", () => {
  it("builds a host seam from the injected platform and environment", async () => {
    const host = createSystemProcessOwnershipHost("win32", {
      PATH: "/injected/path",
    });
    expect(host.platform).toBe("win32");
    await expect(host.listProcesses()).resolves.toEqual([]);
  });

  it("fails closed when a descendant in another process group lacks the token", async () => {
    const adapter: ProcessOwnershipHost = {
      listProcesses: () =>
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
            processGroupId: 101,
            state: "S",
            command: "child-session",
          },
        ]),
      environment: (pid) =>
        Promise.resolve({
          REA_PROCESS_RUN_ID: pid === 100 ? "run-token" : "other-run",
        }),
      signalGroup: vi.fn(),
    };
    await expect(
      observeOwnedProcessLineage(ownership, adapter),
    ).resolves.toEqual({
      status: "unavailable",
      observedAt: expect.any(String),
      runId: "run-token",
      launcherPid: 100,
      processGroupId: 100,
      reason: "process lineage contains an unowned or PID-reused process",
    });
  });
  it("does not publish lineage when any member fails ownership checks", async () => {
    const { adapter } = host({
      100: { REA_PROCESS_RUN_ID: "run-token" },
      101: { REA_PROCESS_RUN_ID: "other-run" },
    });
    await expect(
      observeOwnedProcessLineage(ownership, adapter),
    ).resolves.toEqual({
      status: "unavailable",
      observedAt: expect.any(String),
      runId: "run-token",
      launcherPid: 100,
      processGroupId: 100,
      reason: "process lineage contains an unowned or PID-reused process",
    });
  });
  it("fails closed for stale metadata or an unrelated concurrent process", async () => {
    const { adapter, signalGroup } = host({
      100: { REA_PROCESS_RUN_ID: "run-token" },
      101: { REA_PROCESS_RUN_ID: "different-run" },
    });
    expect(await cleanupOwnedProcessGroup(ownership, adapter)).toEqual({
      cleaned: false,
      reason: "process tree contains an unowned or PID-reused process",
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
      listProcesses: () =>
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
      reason: "process tree contains an unowned or PID-reused process",
      failures: [
        expect.objectContaining({
          pid: 100,
          reason: "environment-unreadable",
          diagnostic: "transient procfs read",
        }),
        { pid: 101, reason: "run-token-mismatch" },
      ],
    });
    expect(signalGroup).not.toHaveBeenCalled();
  });
  it("accepts a member that exits during ownership revalidation", async () => {
    const liveLauncher = {
      pid: 100,
      parentPid: 1,
      processGroupId: 100,
      state: "S",
      command: "fixture",
    };
    const listProcesses = vi
      .fn<ProcessOwnershipHost["listProcesses"]>()
      .mockResolvedValueOnce([liveLauncher])
      .mockResolvedValue([]);
    const signalGroup = vi.fn();
    const adapter: ProcessOwnershipHost = {
      listProcesses,
      environment: () =>
        Promise.reject(new Error("process exited before environment read")),
      signalGroup,
    };
    await expect(cleanupOwnedProcessGroup(ownership, adapter)).resolves.toEqual(
      {
        cleaned: true,
        signaled: false,
      },
    );
    expect(signalGroup).not.toHaveBeenCalled();
  });
});

describe("owned process-group cleanup validation: exited members", () => {
  it("ignores exited zombie members during live ownership checks", async () => {
    const environment = vi.fn((pid: number) =>
      Promise.resolve(pid === 101 ? {} : { REA_PROCESS_RUN_ID: "run-token" }),
    );
    const signalGroup = vi.fn();
    const adapter: ProcessOwnershipHost = {
      listProcesses: () =>
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
    expect(environment.mock.calls).toEqual([[100], [100]]);
    expect(signalGroup).toHaveBeenCalledWith(100, "SIGKILL");
  });
  it("observes a zombie-only group as settled", async () => {
    const environment = vi.fn(() => Promise.resolve({}));
    const adapter: ProcessOwnershipHost = {
      listProcesses: () =>
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
      reason:
        "owned launcher command identity did not match (observed=fixture; expected=/owned/hopper)",
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
