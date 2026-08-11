import { describe, expect, it, vi } from "vitest";
import {
  cleanupOwnedProcessGroup,
  parseProcessEnvironment,
  selectCapturedProcessGroupIds,
  type ProcessOwnershipHost,
} from "./ProcessOwnership.js";
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
