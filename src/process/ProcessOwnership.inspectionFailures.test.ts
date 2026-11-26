import { expect, it, vi } from "vitest";

import { failedInspectionDescriptor } from "../../tests/fixtures/processInspectionCleanup.js";
import {
  cleanupOwnedProcessGroup,
  type OwnedProcessGroup,
  type ProcessOwnershipHost,
  type ProcessTableEntry,
} from "./ProcessOwnership.js";
import { createOwnership } from "./ProcessOwnership.fixture.js";

const stages = [
  "initial table",
  "group revalidation",
  "final verification",
  "exit refresh confirmation",
  "token liveness recheck",
  "unreadable token retry",
  "sweep final table",
] as const;
type Stage = (typeof stages)[number];

const row: ProcessTableEntry = {
  pid: 100,
  parentPid: 1,
  processGroupId: 100,
  state: "S",
  command: "fixture",
};

/** Two synthetic groups only; no native host, process launch or OS signal port. */
const replay = (stage: Stage, failure: unknown) => {
  const other: ProcessTableEntry = { ...row, pid: 200, processGroupId: 200 };
  const before: readonly (readonly ProcessTableEntry[])[] =
    stage === "initial table"
      ? []
      : stage === "final verification"
        ? [[row], [row], [row]]
        : stage === "exit refresh confirmation"
          ? [[{ ...row, command: "replaced" }], [other]]
          : [[row]];
  const sweep =
    stage === "final verification" ||
    stage === "unreadable token retry" ||
    stage === "sweep final table";
  const ownership: OwnedProcessGroup = {
    ...createOwnership(),
    expectedCommand: "fixture",
    ...(sweep ? { sweepTokenOwnedProcesses: true } : {}),
  };
  let reads = 0;
  const listProcesses = async () => {
    const step = reads++;
    if (step < before.length) return before[step]!;
    if (step === before.length) throw failure;
    if (step > before.length + 5) throw new Error("recording table exhausted");
    return [];
  };
  const environment = async (pid: number) => {
    expect([100, 200]).toContain(pid);
    if (
      stage === "exit refresh confirmation" ||
      stage === "token liveness recheck" ||
      stage === "unreadable token retry"
    )
      throw Object.assign(
        new Error("recorded optional environment read failure"),
        { code: "EIO" },
      );
    return { REA_PROCESS_RUN_ID: ownership.runId };
  };
  const signalGroup = vi.fn((group: number, signal: NodeJS.Signals) => {
    expect(stage).toBe("final verification");
    expect(group).toBe(100);
    expect(signal).toBe("SIGKILL");
  });
  const host: ProcessOwnershipHost = {
    platform: "linux",
    listProcesses,
    environment,
    signalGroup,
  };
  return { host, ownership, signalGroup };
};

it.each(stages)(
  "transfers the exact failed descriptor from mandatory %s inspection",
  async (stage) => {
    const descriptor = await failedInspectionDescriptor();
    const recorded = replay(stage, descriptor.failure);
    try {
      const observed = await cleanupOwnedProcessGroup(
        recorded.ownership,
        recorded.host,
      ).catch((cause: unknown) => cause);
      expect(observed).toBe(descriptor.failure);
      expect(recorded.signalGroup).toHaveBeenCalledTimes(
        stage === "final verification" ? 1 : 0,
      );
      expect(descriptor.handle.fd).toBeGreaterThanOrEqual(0);
      await expect(descriptor.failure.owner.close()).rejects.toBeDefined();
    } finally {
      descriptor.allow();
      await descriptor.failure.owner.close();
      expect(descriptor.handle.fd).toBe(-1);
    }
  },
);

it.each(stages)(
  "keeps the ordinary EIO policy at %s without adopting an opaque cause",
  async (stage) => {
    const descriptor = await failedInspectionDescriptor();
    const closes = descriptor.closes();
    const failure = Object.assign(
      new Error("recorded table EIO", { cause: descriptor.failure }),
      { code: "EIO" },
    );
    const recorded = replay(stage, failure);
    try {
      const outcome = await cleanupOwnedProcessGroup(
        recorded.ownership,
        recorded.host,
      );
      const recovered =
        stage === "final verification" ||
        stage === "unreadable token retry" ||
        stage === "sweep final table";
      expect(outcome.cleaned).toBe(recovered);
      expect(recorded.signalGroup).toHaveBeenCalledTimes(
        stage === "final verification" ? 1 : 0,
      );
      expect(descriptor.closes()).toBe(closes);
      expect(descriptor.handle.fd).toBeGreaterThanOrEqual(0);
    } finally {
      descriptor.allow();
      await descriptor.failure.owner.close();
    }
  },
);

it("refuses cleanup when a live member's token is unverifiable", async () => {
  const signalGroup = vi.fn();
  const host: ProcessOwnershipHost = {
    platform: "linux",
    listProcesses: async () => [row],
    environment: async () => {
      throw Object.assign(new Error("recorded unavailable token"), {
        code: "ESRCH",
      });
    },
    signalGroup,
  };
  expect(await cleanupOwnedProcessGroup(createOwnership(), host)).toMatchObject(
    {
      cleaned: false,
      failures: [{ pid: 100, reason: "environment-unreadable" }],
    },
  );
  expect(signalGroup).not.toHaveBeenCalled();
});
