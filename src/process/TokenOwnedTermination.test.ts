import { describe, expect, it, vi } from "vitest";

import type {
  ProcessIdentityObservation,
  ProcessOwnershipHost,
  ProcessTableEntry,
} from "./ProcessOwnership.js";
import { terminateTokenOwnedProcesses } from "./TokenOwnedTermination.js";

interface FakeProcess extends ProcessTableEntry {
  readonly runId?: string;
}

/** A process table whose members exit when SIGTERM reaches them, unless they ignore it. */
const fakeHost = (
  processes: readonly FakeProcess[],
  ignoresTerm: ReadonlySet<number> = new Set(),
  groupUnread: ReadonlySet<number> = new Set(),
) => {
  const live = new Map(processes.map((entry) => [entry.pid, entry]));
  const terminate = (pid: number) => {
    if (!ignoresTerm.has(pid)) live.delete(pid);
  };
  const signalGroup = vi.fn((group: number) => {
    for (const entry of live.values())
      if (entry.processGroupId === group) terminate(entry.pid);
  });
  const signalProcess = vi.fn((pid: number) => {
    terminate(pid);
  });
  const ownership: ProcessOwnershipHost = {
    platform: "linux",
    listProcesses: async () => [...live.values()],
    environment: async (pid) => {
      const runId = live.get(pid)?.runId;
      return runId === undefined ? {} : { REA_PROCESS_RUN_ID: runId };
    },
    processIdentities: async (rows) =>
      new Map(
        rows.map(({ pid }): [number, ProcessIdentityObservation] => {
          const entry = live.get(pid);
          return [
            pid,
            entry === undefined
              ? { state: "absent", reason: "not-found-in-caller-pid-namespace" }
              : {
                  state: "readable",
                  identity: `start:${String(pid)}`,
                  lifecycle: { state: "observed", lifecycle: "non-zombie" },
                  relation: groupUnread.has(pid)
                    ? { state: "unavailable", reason: "stat unreadable" }
                    : {
                        state: "observed",
                        parentPid: entry.parentPid,
                        processGroupId: entry.processGroupId,
                      },
                },
          ];
        }),
      ),
    signalGroup,
  };
  return { host: { ownership, signalProcess }, signalGroup, signalProcess };
};

const row = (
  pid: number,
  processGroupId: number,
  runId?: string,
): FakeProcess => ({
  pid,
  parentPid: 1,
  processGroupId,
  state: "S",
  command: "fixture",
  ...(runId === undefined ? {} : { runId }),
});

describe("terminateTokenOwnedProcesses", () => {
  it("sends SIGTERM to the launch group and to token carriers that left it, never to others", async () => {
    const { host, signalGroup, signalProcess } = fakeHost([
      row(100, 100, "run"),
      row(101, 100),
      row(200, 200, "run"),
      row(300, 300, "other-run"),
      row(400, 400),
    ]);

    expect(
      await terminateTokenOwnedProcesses(
        { runId: "run", processGroupId: 100 },
        1_000,
        host,
      ),
    ).toEqual({ launchGroupSignalled: true });

    expect(signalGroup.mock.calls).toEqual([[100, "SIGTERM"]]);
    expect(signalProcess.mock.calls).toEqual([[200, "SIGTERM"]]);
    expect(
      (await host.ownership.listProcesses()).map(({ pid }) => pid),
    ).toEqual([300, 400]);
  });

  it("does not signal the launch group when no member is proven to carry the token", async () => {
    const { host, signalGroup, signalProcess } = fakeHost([
      row(101, 100),
      row(200, 200, "run"),
    ]);

    expect(
      await terminateTokenOwnedProcesses(
        { runId: "run", processGroupId: 100 },
        1_000,
        host,
      ),
    ).toEqual({ launchGroupSignalled: false });

    expect(signalGroup).not.toHaveBeenCalled();
    expect(signalProcess.mock.calls).toEqual([[200, "SIGTERM"]]);
  });

  it("signals a carrier whose current group is unknown on its own, not through the launch group", async () => {
    const { host, signalGroup, signalProcess } = fakeHost(
      [row(100, 100, "run")],
      new Set(),
      new Set([100]),
    );

    expect(
      await terminateTokenOwnedProcesses(
        { runId: "run", processGroupId: 100 },
        1_000,
        host,
      ),
    ).toEqual({ launchGroupSignalled: false });

    expect(signalGroup).not.toHaveBeenCalled();
    expect(signalProcess.mock.calls).toEqual([[100, "SIGTERM"]]);
  });

  it("waits for the grace period when a process ignores SIGTERM", async () => {
    const { host } = fakeHost([row(100, 100, "run")], new Set([100]));
    const started = performance.now();

    await terminateTokenOwnedProcesses(
      { runId: "run", processGroupId: 100 },
      300,
      host,
    );

    expect(performance.now() - started).toBeGreaterThanOrEqual(250);
  });
});
