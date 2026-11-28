import { expect, it, vi } from "vitest";
import {
  verifyNoTokenOwnedProcesses,
  type ProcessIdentityObservation,
  type ProcessOwnershipHost,
  type ProcessTableEntry,
} from "./ProcessOwnership.js";
import { ProcessOwnershipEvidenceOwner } from "./ProcessOwnershipEvidence.js";

const row: ProcessTableEntry = {
  pid: 900,
  parentPid: 1,
  processGroupId: 900,
  state: "S",
  command: "baseline-candidate",
};
const absent: ProcessIdentityObservation = {
  state: "absent",
  reason: "not-in-snapshot",
};
const unavailable: ProcessIdentityObservation = {
  state: "unavailable",
  reason: "identity access denied",
};
const identity = (related = false): ProcessIdentityObservation => ({
  state: "readable",
  identity: "current-generation",
  relation: {
    state: "observed",
    parentPid: related ? 100 : 1,
    processGroupId: related ? 100 : 900,
  },
});

it.each([
  {
    name: "exited after an unavailable initial identity",
    baseline: "prior-generation",
    before: unavailable,
    after: absent,
  },
])(
  "reconciles a baseline candidate that $name",
  async ({ baseline, before, after }) => {
    let reads = 0;
    const signalGroup = vi.fn();
    const evidenceOwner = new ProcessOwnershipEvidenceOwner();
    const host: ProcessOwnershipHost = {
      listProcesses: () => Promise.resolve([row]),
      environment: () => Promise.resolve({}),
      processIdentities: () =>
        Promise.resolve(new Map([[row.pid, reads++ === 0 ? before : after]])),
      runTokens: () =>
        Promise.resolve(
          new Map([
            [row.pid, { state: "readable", runId: undefined } as const],
          ]),
        ),
      signalGroup,
    };

    await expect(
      verifyNoTokenOwnedProcesses(
        "run-token",
        host,
        [{ pid: row.pid, identity: baseline }],
        { leaderPid: 100, processGroupId: 100, evidenceOwner },
      ),
    ).resolves.toEqual({ cleaned: true, signaled: false });
    expect(evidenceOwner.candidates).toEqual([]);
    expect(signalGroup).not.toHaveBeenCalled();
  },
);

it.each([
  { name: "unrelated withheld token", related: false, withheld: true },
  { name: "related withheld token", related: true, withheld: true },
  { name: "unrelated access failure", related: false, withheld: false },
])("preserves the final facts for $name", async ({ related, withheld }) => {
  const reason = withheld
    ? "platform_binary_environment_withheld"
    : "permission denied";
  const evidenceOwner = new ProcessOwnershipEvidenceOwner();
  const signalGroup = vi.fn();
  const host: ProcessOwnershipHost = {
    platform: "darwin",
    listProcesses: () => Promise.resolve([row]),
    environment: () => Promise.resolve({}),
    processIdentities: () =>
      Promise.resolve(new Map([[row.pid, identity(related)]])),
    runTokens: () =>
      Promise.resolve(
        new Map([[row.pid, { state: "unavailable", reason } as const]]),
      ),
    signalGroup,
  };

  const result = await verifyNoTokenOwnedProcesses(
    "run-token",
    host,
    [{ pid: row.pid, identity: null }],
    { leaderPid: 100, processGroupId: 100, evidenceOwner },
  );

  if (!related && withheld) {
    expect(result).toEqual({
      cleaned: true,
      signaled: false,
      unverified: [{ pid: row.pid, diagnostic: reason }],
    });
  } else {
    expect(result).toMatchObject({
      cleaned: false,
      failures: [
        { pid: row.pid, reason: "environment-unreadable", diagnostic: reason },
      ],
    });
  }
  expect(evidenceOwner.candidates).toHaveLength(related ? 1 : 0);
  expect(signalGroup).not.toHaveBeenCalled();
});
