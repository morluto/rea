import { expect, it, vi } from "vitest";
import { prepareVerifierTokenCleanup } from "../../../scripts/lib/verifier-token-cleanup.mjs";
import type {
  ProcessOwnershipHost,
  ProcessTableEntry,
} from "../../../src/process/ProcessOwnership.js";

it("rejects a token-owned survivor after it is reparented outside the verifier tree", async () => {
  const launcher: ProcessTableEntry = {
    pid: 100,
    parentPid: 50,
    processGroupId: 100,
    state: "S",
    command: "verifier",
  };
  const orphan: ProcessTableEntry = {
    pid: 200,
    parentPid: 1,
    processGroupId: 200,
    state: "S",
    command: "Ghidra control",
  };
  let rows = [launcher];
  const close = vi.fn();
  const host: ProcessOwnershipHost = {
    platform: "linux",
    prepare: vi.fn(),
    close,
    captureBaseline: async () => [{ pid: launcher.pid, identity: "start:100" }],
    listProcesses: async () => rows,
    environment: async (pid) =>
      pid === orphan.pid ? { REA_PROCESS_RUN_ID: "owned-run" } : {},
    runTokens: async (selected) =>
      new Map(
        selected.map(({ pid }) => [
          pid,
          {
            state: "readable",
            runId: pid === orphan.pid ? "owned-run" : undefined,
          } as const,
        ]),
      ),
    processIdentities: async (selected) =>
      new Map(
        selected.map((row) => [
          row.pid,
          rows.some(({ pid }) => pid === row.pid)
            ? ({
                state: "readable",
                identity: `start:${row.pid}`,
                lifecycle: { state: "observed", lifecycle: "non-zombie" },
                relation: {
                  state: "observed",
                  parentPid: row.parentPid,
                  processGroupId: row.processGroupId,
                },
              } as const)
            : ({
                state: "absent",
                reason: "not-found-in-caller-pid-namespace",
              } as const),
        ]),
      ),
    signalGroup: vi.fn(),
  };
  const cleanup = await prepareVerifierTokenCleanup(
    { run_id: "owned-run", verifier_pid: 100, parent_pid: 50 },
    host,
  );
  rows = [launcher, orphan];
  expect(rows.filter(({ parentPid }) => parentPid === launcher.pid)).toEqual(
    [],
  );
  expect(await cleanup.verify()).toMatchObject({
    cleaned: false,
    reason: "token-owned process remained after cleanup",
  });
  rows = [launcher];
  expect(await cleanup.verify()).toMatchObject({ cleaned: true });
  await cleanup.close();
  expect(close).toHaveBeenCalledOnce();
  expect(host.signalGroup).not.toHaveBeenCalled();
});

it("closes the inspection host when baseline ownership cannot be established", async () => {
  const close = vi.fn();
  const host: ProcessOwnershipHost = {
    listProcesses: async () => [],
    environment: async () => ({}),
    signalGroup: vi.fn(),
    close,
  };
  await expect(
    prepareVerifierTokenCleanup(
      { run_id: "owned-run", verifier_pid: 100, parent_pid: 50 },
      host,
    ),
  ).rejects.toThrow("baseline is unavailable");
  expect(close).toHaveBeenCalledOnce();
});
