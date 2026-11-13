import { expect, it } from "vitest";
import {
  verifyNoTokenOwnedProcesses,
  type ProcessIdentityObservation,
  type ProcessOwnershipHost,
  type ProcessRunTokenObservation,
  type ProcessTableEntry,
} from "./ProcessOwnership.js";
import { ProcessOwnershipEvidenceOwner } from "./ProcessOwnershipEvidence.js";

/**
 * A kernel thread that appeared while the capture ran. The kernel reports it
 * with ppid 2 and pgid 0; the capture never forked it and it never inherits
 * the provider's environment.
 */
const kernelThread: ProcessTableEntry = {
  pid: 200,
  parentPid: 2,
  processGroupId: 0,
  state: "R",
  command: "psimon",
};

/**
 * Rows present while the capture runs (and so in its snapshot), but released
 * before the final verification below.
 */
const captureRows: readonly ProcessTableEntry[] = [
  {
    pid: 100,
    parentPid: 1,
    processGroupId: 100,
    state: "S",
    command: "capture-root",
  },
  {
    pid: 101,
    parentPid: 100,
    processGroupId: 100,
    state: "S",
    command: "capture-child",
  },
];

const makeHost = (options: {
  readonly kernelThread: boolean;
}): ProcessOwnershipHost => ({
  platform: "linux",
  // Cleanup already released the capture tree; only the kernel thread remains.
  listProcesses: async () => [kernelThread],
  environment: async () => ({}),
  runTokens: async (entries) =>
    new Map<number, ProcessRunTokenObservation>(
      entries.map(({ pid }) => [
        pid,
        pid === kernelThread.pid
          ? // The thread exited between the snapshot and its environment read.
            {
              state: "unavailable",
              code: "ESRCH",
              reason: "ESRCH: no such process",
            }
          : { state: "readable", runId: "sweep-run" },
      ]),
    ),
  processIdentities: async (entries) =>
    new Map<number, ProcessIdentityObservation>(
      entries.map((entry) => {
        if (entry.pid !== kernelThread.pid)
          return [
            entry.pid,
            {
              state: "absent" as const,
              reason: "not-found-in-caller-pid-namespace" as const,
            },
          ] as const;
        return [
          entry.pid,
          {
            state: "readable" as const,
            identity: `start-${String(entry.pid)}`,
            lifecycle: {
              state: "observed" as const,
              lifecycle: "non-zombie" as const,
            },
            relation: {
              state: "observed" as const,
              parentPid: kernelThread.parentPid,
              processGroupId: kernelThread.processGroupId,
            },
            ...(options.kernelThread ? { kernelThread: true as const } : {}),
          },
        ] as const;
      }),
    ),
  captureBaseline: async () =>
    captureRows.map(({ pid }) => ({
      pid,
      identity: `start-${String(pid)}`,
    })),
  signalGroup: () => undefined,
});

const relation = {
  leaderPid: 100,
  processGroupId: 100,
  evidenceOwner: new ProcessOwnershipEvidenceOwner(),
};

it("exonerates an unrelated kernel thread whose token read raced its exit", async () => {
  await expect(
    verifyNoTokenOwnedProcesses(
      "sweep-run",
      makeHost({ kernelThread: true }),
      undefined,
      relation,
    ),
  ).resolves.toEqual({
    cleaned: true,
    signaled: false,
    unverified: [{ pid: kernelThread.pid, diagnostic: "ESRCH: no such process" }],
  });
});

it("keeps an unrelated user process with an unreadable token fail-closed", async () => {
  // The same ESRCH diagnostic without the native PF_KTHREAD fact stays a
  // cleanup failure: only the kernel-thread observation exonerates it.
  await expect(
    verifyNoTokenOwnedProcesses(
      "sweep-run",
      makeHost({ kernelThread: false }),
      undefined,
      relation,
    ),
  ).resolves.toMatchObject({
    cleaned: false,
    reason: expect.stringContaining(
      "process ownership token could not be read for 1 live process(es)",
    ),
  });
});
