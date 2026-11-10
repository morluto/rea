import { expect, it, vi } from "vitest";

import {
  cleanupOwnedProcessGroup,
  type OwnedProcessGroup,
  type ProcessIdentityObservation,
  type ProcessOwnershipHost,
  type ProcessRunTokenObservation,
  type ProcessTableEntry,
} from "./ProcessOwnership.js";
import { ProcessOwnershipEvidenceOwner } from "./ProcessOwnershipEvidence.js";
import { TOKEN_READ_RETRY_ATTEMPTS } from "./ProcessOwnershipObservation.js";

const RUN_ID = "verifier-run";
// The verifier's packaged CLI leader has exited; its child stays in the group.
const LEADER = 100;

const member = (pid: number): ProcessTableEntry => ({
  pid,
  parentPid: LEADER,
  processGroupId: LEADER,
  state: "S",
  command: `child-${String(pid)}`,
});

const PATH_PADDING = "malformed_procargs_path_padding";

/**
 * Darwin host whose members stay in the leader's group until it is signaled.
 * `token` decides each member's run-token read by the 1-based batch number.
 */
const darwinHost = (options: {
  readonly members: readonly number[];
  readonly token: (pid: number, batch: number) => ProcessRunTokenObservation;
  readonly identity?: (pid: number, batch: number) => string | undefined;
}) => {
  let signaled = false;
  let tokenBatches = 0;
  const tokenReads: number[][] = [];
  const signalGroup = vi.fn((processGroupId: number) => {
    if (processGroupId === LEADER) signaled = true;
  });
  const host: ProcessOwnershipHost = {
    platform: "darwin",
    listProcesses: async () => (signaled ? [] : options.members.map(member)),
    environment: async () => ({}),
    runTokens: async (entries) => {
      tokenBatches += 1;
      tokenReads.push(entries.map(({ pid }) => pid));
      return new Map(
        entries.map(({ pid }) => [pid, options.token(pid, tokenBatches)]),
      );
    },
    processIdentities: async (entries) =>
      new Map<number, ProcessIdentityObservation>(
        entries.map(({ pid }) => {
          const identity =
            options.identity?.(pid, tokenBatches) ?? `start-${String(pid)}`;
          return [
            pid,
            signaled || pid === LEADER || !options.members.includes(pid)
              ? { state: "absent", reason: "not-in-snapshot" }
              : {
                  state: "readable",
                  identity,
                  name: "node",
                  lifecycle: { state: "observed", lifecycle: "non-zombie" },
                  relation: {
                    state: "observed",
                    parentPid: LEADER,
                    processGroupId: LEADER,
                  },
                },
          ];
        }),
      ),
    signalGroup,
  };
  return { host, signalGroup, tokenReads };
};

// A verifier command sweeps with one evidence owner for its whole lifetime.
const ownership = (sweep: boolean): OwnedProcessGroup => {
  const group = { runId: RUN_ID, leaderPid: LEADER, processGroupId: LEADER };
  return sweep
    ? {
        ...group,
        sweepTokenOwnedProcesses: true,
        evidenceOwner: new ProcessOwnershipEvidenceOwner(),
        captureBaseline: [],
      }
    : group;
};

const owned: ProcessRunTokenObservation = { state: "readable", runId: RUN_ID };
const unreadable: ProcessRunTokenObservation = {
  state: "unavailable",
  reason: PATH_PADDING,
};

// With a full sweep, batch 1 is the sweep and batch 2 the pre-signal group
// check. Without one, the group check reads first.
it.each([
  { sweep: false, groupCheck: 1 },
  { sweep: true, groupCheck: 2 },
])(
  "re-reads a transiently unreadable member before signaling its group: %j",
  async ({ sweep, groupCheck }) => {
    const { host, signalGroup, tokenReads } = darwinHost({
      members: [101],
      token: (_pid, batch) => (batch === groupCheck ? unreadable : owned),
    });

    await expect(
      cleanupOwnedProcessGroup(ownership(sweep), host),
    ).resolves.toEqual({ cleaned: true, signaled: true });
    expect(signalGroup).toHaveBeenCalledWith(LEADER, "SIGKILL");
    expect(tokenReads[groupCheck]).toEqual([101]);
  },
);

it.each([false, true])(
  "fails closed and names a member whose token stays unreadable (sweep %s)",
  async (sweep) => {
    const { host, signalGroup, tokenReads } = darwinHost({
      members: [101],
      token: () => unreadable,
    });

    const result = await cleanupOwnedProcessGroup(ownership(sweep), host);

    expect(result).toEqual({
      cleaned: false,
      // The summary names the candidate from the native facts it carries.
      reason: expect.stringContaining(
        `live candidates 101=${PATH_PADDING} (name "node", ppid 100, pgid 100, identity start-101)`,
      ),
      failures: [
        {
          pid: 101,
          reason: "environment-unreadable",
          diagnostic: PATH_PADDING,
          identityAfter: expect.objectContaining({
            identity: "start-101",
            name: "node",
            relation: {
              state: "observed",
              parentPid: LEADER,
              processGroupId: LEADER,
            },
          }),
        },
      ],
    });
    expect(signalGroup).not.toHaveBeenCalled();
    // One read plus the bounded re-reads for the sweep and the group check.
    expect(tokenReads).toHaveLength(
      (1 + TOKEN_READ_RETRY_ATTEMPTS) * (sweep ? 2 : 1),
    );
  },
);

it("accepts a member that exits while its unreadable token is re-read", async () => {
  let exited = false;
  const { host, signalGroup } = darwinHost({
    members: [101],
    token: () => unreadable,
    identity: (_pid, batch) => {
      if (batch >= 1) exited = true;
      return undefined;
    },
  });
  const listProcesses = host.listProcesses;
  const exitingHost: ProcessOwnershipHost = {
    ...host,
    listProcesses: async () => (exited ? [] : listProcesses()),
    processIdentities: async (entries, signal, credentials) =>
      exited
        ? new Map(
            entries.map(({ pid }) => [
              pid,
              { state: "absent", reason: "not-in-snapshot" } as const,
            ]),
          )
        : (host.processIdentities?.(entries, signal, credentials) ?? new Map()),
  };

  await expect(
    cleanupOwnedProcessGroup(ownership(false), exitingHost),
  ).resolves.toEqual({ cleaned: true, signaled: false });
  expect(signalGroup).not.toHaveBeenCalled();
});

it.each([
  {
    // The re-read's bracket straddles PID reuse; its own reads disagree.
    reuse: "during the re-read",
    replacement: () => (_pid: number, batch: number) =>
      batch >= 2 ? "start-101-reused" : undefined,
  },
  {
    // The PID is reused before the re-read starts, so both of its identity
    // reads agree; only the first-read generation can reject its token.
    reuse: "before the re-read",
    replacement: () => {
      let readsAfterFirstToken = 0;
      return (_pid: number, batch: number) =>
        batch >= 1 && ++readsAfterFirstToken > 1
          ? "start-101-reused"
          : undefined;
    },
  },
])(
  "keeps a PID reused $reuse unresolved instead of trusting the replacement's token",
  async ({ replacement }) => {
    const { host, signalGroup } = darwinHost({
      members: [101],
      token: (_pid, batch) => (batch === 1 ? unreadable : owned),
      identity: replacement(),
    });

    await expect(
      cleanupOwnedProcessGroup(ownership(false), host),
    ).resolves.toMatchObject({
      cleaned: false,
      failures: [{ pid: 101, reason: "process-identity-unavailable" }],
    });
    expect(signalGroup).not.toHaveBeenCalled();
  },
);

it("keeps a PID reuse found by the first read unresolved across token re-reads", async () => {
  // Linux reports the vanished token with ESRCH, and the first read's exit
  // check already sees a zombie replacement. That known change must not be
  // re-read into the replacement's exited facts.
  let tokenReads = 0;
  let identityReadsAfterToken = 0;
  const signalGroup = vi.fn();
  const host: ProcessOwnershipHost = {
    platform: "linux",
    listProcesses: async () => [member(101)],
    environment: async () => ({}),
    runTokens: async (entries) => {
      tokenReads += 1;
      return new Map(
        entries.map(({ pid }) => [
          pid,
          { state: "unavailable", reason: "vanished", code: "ESRCH" } as const,
        ]),
      );
    },
    processIdentities: async (entries) =>
      new Map<number, ProcessIdentityObservation>(
        entries.map(({ pid }) => {
          const replaced = tokenReads > 0 && ++identityReadsAfterToken > 1;
          return [
            pid,
            {
              state: "readable",
              identity: replaced ? "start-101-reused" : "start-101",
              lifecycle: {
                state: "observed",
                lifecycle: replaced ? "zombie" : "non-zombie",
              },
              relation: {
                state: "observed",
                parentPid: LEADER,
                processGroupId: LEADER,
              },
            },
          ];
        }),
      ),
    signalGroup,
  };

  await expect(
    cleanupOwnedProcessGroup(ownership(false), host),
  ).resolves.toMatchObject({
    cleaned: false,
    failures: [{ pid: 101, reason: "process-identity-unavailable" }],
  });
  expect(tokenReads).toBe(1);
  expect(signalGroup).not.toHaveBeenCalled();
});

it("keeps a readable member that changes groups while another member's token is re-read", async () => {
  // 101 is readable and owned on the first read; 102 needs one re-read.
  // While cleanup waits for 102, 101 moves to group 200 and must not escape.
  const MOVED_GROUP = 200;
  const groups = new Map([
    [101, LEADER],
    [102, LEADER],
  ]);
  let tokenBatches = 0;
  const signalGroup = vi.fn((processGroupId: number) => {
    for (const [pid, group] of groups)
      if (group === processGroupId) groups.delete(pid);
  });
  const host: ProcessOwnershipHost = {
    platform: "darwin",
    listProcesses: async () =>
      [...groups].map(([pid, processGroupId]) => ({
        ...member(pid),
        processGroupId,
      })),
    environment: async () => ({}),
    runTokens: async (entries) => {
      tokenBatches += 1;
      if (tokenBatches === 2) groups.set(101, MOVED_GROUP);
      return new Map(
        entries.map(({ pid }) => [
          pid,
          pid === 102 && tokenBatches === 1 ? unreadable : owned,
        ]),
      );
    },
    processIdentities: async (entries) =>
      new Map<number, ProcessIdentityObservation>(
        entries.map(({ pid }) => {
          const processGroupId = groups.get(pid);
          return [
            pid,
            processGroupId === undefined
              ? { state: "absent", reason: "not-in-snapshot" }
              : {
                  state: "readable",
                  identity: `start-${String(pid)}`,
                  lifecycle: { state: "observed", lifecycle: "non-zombie" },
                  relation: {
                    state: "observed",
                    parentPid: LEADER,
                    processGroupId,
                  },
                },
          ];
        }),
      ),
    signalGroup,
  };

  await expect(
    cleanupOwnedProcessGroup(ownership(false), host),
  ).resolves.toMatchObject({
    cleaned: false,
    failures: [{ pid: 101, reason: "process-identity-unavailable" }],
  });
  expect(signalGroup).not.toHaveBeenCalled();
  expect(groups.get(101)).toBe(MOVED_GROUP);
});

it("reports only the persistent member when group members have mixed token outcomes", async () => {
  const { host, signalGroup } = darwinHost({
    members: [101, 102],
    token: (pid, batch) => (pid === 102 || batch === 1 ? unreadable : owned),
  });

  const result = await cleanupOwnedProcessGroup(ownership(false), host);

  expect(result).toMatchObject({
    cleaned: false,
    reason: expect.stringContaining(
      `live candidates 102=${PATH_PADDING} (name "node", ppid 100, pgid 100, identity start-102)`,
    ),
    failures: [{ pid: 102, reason: "environment-unreadable" }],
  });
  expect(result.cleaned === false && result.reason).not.toContain("101=");
  expect(signalGroup).not.toHaveBeenCalled();
});

it("re-reads a member whose refresh turns unreadable within the same bound", async () => {
  // 102 needs a re-read; 101's own second read, its refresh, is transient.
  let reads101 = 0;
  const { host, signalGroup } = darwinHost({
    members: [101, 102],
    token: (pid, batch) =>
      (pid === 102 && batch === 1) || (pid === 101 && ++reads101 === 2)
        ? unreadable
        : owned,
  });

  await expect(
    cleanupOwnedProcessGroup(ownership(false), host),
  ).resolves.toEqual({ cleaned: true, signaled: true });
  expect(signalGroup).toHaveBeenCalledWith(LEADER, "SIGKILL");
});

it("signals on a cleanup retry once the retained member's token becomes readable", async () => {
  let readable = false;
  const { host, signalGroup } = darwinHost({
    members: [101],
    token: () => (readable ? owned : unreadable),
  });
  const group = ownership(true);

  await expect(cleanupOwnedProcessGroup(group, host)).resolves.toMatchObject({
    cleaned: false,
    failures: [{ pid: 101, reason: "environment-unreadable" }],
  });
  expect(signalGroup).not.toHaveBeenCalled();

  readable = true;
  await expect(cleanupOwnedProcessGroup(group, host)).resolves.toEqual({
    cleaned: true,
    signaled: true,
  });
  expect(signalGroup).toHaveBeenCalledWith(LEADER, "SIGKILL");
});
