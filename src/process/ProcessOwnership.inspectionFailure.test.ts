import { expect, it, vi } from "vitest";

const inspect = vi.hoisted(() => vi.fn());
vi.mock("./ExecFileOutput.js", () => ({ execFileOutput: inspect }));

import { createSystemProcessOwnershipHost } from "./ProcessOwnershipObservation.js";
import {
  cleanupOwnedProcessGroup,
  verifyNoTokenOwnedProcesses,
} from "./ProcessOwnership.js";

it.each(["darwin", "linux"] as const)(
  "preserves the denied inspector at the %s host and cleanup boundaries",
  async (platform) => {
    inspect.mockRejectedValue(
      Object.assign(new Error("spawn EPERM"), {
        code: "EPERM",
        syscall: "spawn ps",
      }),
    );
    const signalGroup = vi.fn();
    const host = {
      ...createSystemProcessOwnershipHost(platform, {}),
      signalGroup,
    };
    const diagnostic = {
      capability: "process_table",
      command: "ps",
      arguments: ["-axo", "pid=,ppid=,pgid=,uid=,stat=,command="],
      system_code: "EPERM",
      reason: "spawn EPERM",
    };
    await expect(host.listProcesses()).rejects.toMatchObject({
      inspection: diagnostic,
    });
    for (const outcome of [
      await cleanupOwnedProcessGroup(
        { leaderPid: 100, processGroupId: 100, runId: "fixture" },
        host,
      ),
      await verifyNoTokenOwnedProcesses("fixture", host),
    ]) {
      expect(outcome).toMatchObject({ cleaned: false, inspection: diagnostic });
    }
    expect(signalGroup).not.toHaveBeenCalled();
  },
);

it("retains inspection failure on the launcher-exit refresh without replacing the identity failure", async () => {
  inspect.mockResolvedValueOnce({ stdout: "100 1 100 501 S fixture\n" });
  inspect.mockRejectedValueOnce(
    Object.assign(new Error("spawn EPERM"), { code: "EPERM" }),
  );
  const native = createSystemProcessOwnershipHost("linux", {});
  const signalGroup = vi.fn();
  const result = await cleanupOwnedProcessGroup(
    {
      leaderPid: 100,
      processGroupId: 100,
      runId: "fixture",
      expectedParentPid: 2,
    },
    {
      listProcesses: native.listProcesses,
      environment: async () => ({ REA_PROCESS_RUN_ID: "fixture" }),
      signalGroup,
    },
  );
  expect(result).toMatchObject({
    cleaned: false,
    reason: expect.stringContaining("parent"),
    inspection: { command: "ps", system_code: "EPERM" },
  });
  expect(signalGroup).not.toHaveBeenCalled();
});

it("keeps caller cancellation distinct from an inspection refusal", async () => {
  const controller = new AbortController();
  const reason = new Error("caller stopped inspection");
  controller.abort(reason);
  inspect.mockRejectedValueOnce(reason);
  const host = createSystemProcessOwnershipHost("linux", {});
  await expect(host.listProcesses(controller.signal)).rejects.toBe(reason);
});
