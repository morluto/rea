import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  errorMessage,
  systemProcessOwnershipHost as systemHost,
} from "./ProcessOwnershipObservation.js";
import { launcherIdentityFailure } from "./ProcessOwnershipIdentity.js";
import { descendantsOf, liveProcesses } from "./ProcessOwnershipProcessTree.js";

const execFileAsync = promisify(execFile);

/** Identity proof required before REA may signal an owned process group. */
export interface OwnedProcessGroup {
  readonly runId: string;
  readonly leaderPid: number;
  readonly processGroupId: number;
  /** Expected launcher identity, checked only while the leader exists. */
  readonly expectedCommand?: string;
  /** Expected launcher parent, checked only while the leader exists. */
  readonly expectedParentPid?: number;
  /** Scan all live processes for this run token during cleanup. */
  readonly sweepTokenOwnedProcesses?: boolean;
  /** Prelaunch process identities for this capture; absent on generic callers. */
  readonly captureBaseline?: ProcessOwnershipBaseline;
}

/** Capture-local baseline; null means the PID identity could not be established. */
export type ProcessOwnershipBaseline = readonly {
  readonly pid: number;
  readonly identity: string | null;
}[];

/** One entry from an operating-system process-table snapshot. */
export interface ProcessTableEntry {
  readonly pid: number;
  readonly parentPid: number;
  readonly processGroupId: number;
  readonly state: string;
  readonly command: string;
}

/** Native process start identity; unavailable identities must never be skipped. */
export type ProcessIdentityObservation =
  | { readonly state: "readable"; readonly identity: string }
  | { readonly state: "unavailable"; readonly reason: string };

/** Token-verified process lineage retained for one owned provider run. */
export interface OwnedProcessLineage {
  readonly runId: string;
  readonly launcherPid: number;
  readonly launcherParentPid: number;
  readonly processGroupId: number;
  readonly descendants: readonly {
    readonly pid: number;
    readonly parentPid: number;
    readonly processGroupId: number;
  }[];
}

/** Result of observing owned lineage without signaling any process. */
export type ProcessLineageObservation =
  | {
      readonly status: "verified";
      readonly observedAt: string;
      readonly lineage: OwnedProcessLineage;
    }
  | {
      readonly status: "unavailable";
      readonly observedAt: string;
      readonly runId: string;
      readonly launcherPid: number;
      readonly processGroupId: number;
      readonly reason: string;
    };

/** Narrow operating-system seam used to inspect processes and signal groups. */
export interface ProcessOwnershipHost {
  readonly platform?: NodeJS.Platform;
  /** Prepare required native identity inspection before launching a child. */
  prepare?(signal?: AbortSignal): Promise<void>;
  /** Release owned native inspection helpers and their temporary files. */
  close?(): Promise<void>;
  listProcesses(): Promise<readonly ProcessTableEntry[]>;
  environment(pid: number): Promise<Readonly<Record<string, string>>>;
  /** Read only run-token values in one host operation when the OS supports it. */
  runTokens?(
    processes: readonly ProcessTableEntry[],
  ): Promise<ReadonlyMap<number, ProcessRunTokenObservation>>;
  /** Read stable per-process identities in one host operation when available. */
  processIdentities?(
    processes: readonly ProcessTableEntry[],
  ): Promise<ReadonlyMap<number, ProcessIdentityObservation>>;
  /** Snapshot identities before a capture launches its selected process. */
  captureBaseline?(): Promise<ProcessOwnershipBaseline>;
  signalGroup(processGroupId: number, signal: NodeJS.Signals): void;
}

/** Whether one live process exposed its ownership token to the host. */
export type ProcessRunTokenObservation =
  | { readonly state: "readable"; readonly runId: string | undefined }
  | { readonly state: "unavailable"; readonly reason: string };

/** Narrow Windows P0 seam for bounded process-tree termination. */
export interface WindowsProcessTreeHost {
  terminateTree(rootPid: number): Promise<"terminated" | "missing">;
}

/** Per-member reason that token-verified cleanup failed closed. */
interface ProcessOwnershipValidationFailure {
  readonly pid: number;
  readonly reason:
    | "environment-unreadable"
    | "run-token-mismatch"
    | "process-identity-unavailable";
  readonly diagnostic?: string;
}

/** Cleanup outcome with per-member diagnostics when ownership is uncertain. */
export type ProcessCleanupResult =
  | { readonly cleaned: true; readonly signaled: boolean }
  | {
      readonly cleaned: false;
      readonly reason: string;
      readonly failures?: readonly {
        readonly pid: number;
        readonly reason:
          | "environment-unreadable"
          | "run-token-mismatch"
          | "process-identity-unavailable";
        readonly diagnostic?: string;
      }[];
    };

/** Token-verified liveness result used by post-root-exit settlement. */
export type ProcessGroupObservation =
  | { readonly state: "empty" }
  | { readonly state: "alive" }
  | { readonly state: "unverifiable"; readonly reason: string };

/**
 * Terminate one Windows process tree through the platform utility.
 *
 * This is a bounded P0 cleanup mechanism, not Job Object ownership proof. The
 * caller-visible Windows capability report remains unavailable until a native
 * authority verifies Job Object creation, membership, and cleanup semantics.
 */
export const cleanupWindowsProcessTree = async (
  rootPid: number,
  host: WindowsProcessTreeHost = systemWindowsProcessTreeHost,
): Promise<ProcessCleanupResult> => {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0)
    return { cleaned: false, reason: "Windows process-tree PID is invalid" };
  try {
    const result = await host.terminateTree(rootPid);
    return { cleaned: true, signaled: result === "terminated" };
  } catch (cause: unknown) {
    // The reason string is a pinned validation contract; keep it stable and
    // do not interpolate the cause into caller-visible diagnostics here.
    void cause;
    return {
      cleaned: false,
      reason:
        "Windows P0 process-tree termination failed; Job Object ownership is unavailable",
    };
  }
};

const systemWindowsProcessTreeHost: WindowsProcessTreeHost = {
  async terminateTree(rootPid) {
    try {
      await execFileAsync(
        "taskkill.exe",
        ["/pid", String(rootPid), "/t", "/f"],
        { windowsHide: true, timeout: 5_000 },
      );
      return "terminated";
    } catch (cause: unknown) {
      if (
        cause instanceof Error &&
        "code" in cause &&
        (cause.code === 128 || cause.code === "ESRCH")
      )
        return "missing";
      throw cause;
    }
  },
};

/** Read the capture run token currently exposed by one live process. */
export const readProcessRunId = async (
  pid: number,
  host: ProcessOwnershipHost = systemHost,
): Promise<string | undefined> =>
  (await host.environment(pid)).REA_PROCESS_RUN_ID;

/** Token-validate every rooted POSIX process group before signaling any. */
export const cleanupOwnedProcessGroup = async (
  ownership: OwnedProcessGroup,
  host: ProcessOwnershipHost = systemHost,
): Promise<ProcessCleanupResult> => {
  const processTable = await readLiveProcessTable(host);
  if (!processTable.available)
    return {
      cleaned: false,
      reason: `process table could not be inspected: ${processTable.reason}`,
    };
  const plan = await createOwnedCleanupPlan(
    ownership,
    processTable.processes,
    host,
  );
  if ("cleaned" in plan) return plan;
  let signaled = false;
  for (const processGroupId of plan.signalOrder) {
    const revalidation = await revalidateOwnedProcessGroup(
      processGroupId,
      ownership,
      host,
      plan.tokenOwnedIdentities,
    );
    if ("cleaned" in revalidation) return revalidation;
    if (revalidation.empty) continue;
    try {
      host.signalGroup(processGroupId, "SIGKILL");
      signaled = true;
    } catch (cause: unknown) {
      const code =
        cause instanceof Error && "code" in cause ? cause.code : undefined;
      if (code !== "ESRCH")
        return {
          cleaned: false,
          reason: `owned process group signal failed: ${errorMessage(cause)}`,
        };
    }
  }
  if (plan.unresolved.length > 0)
    return cleanupValidationFailure(plan.unresolved);
  return { cleaned: true, signaled };
};

/** Verify that no live process still carries an owned capture run token. */
export const verifyNoTokenOwnedProcesses = async (
  runId: string,
  host: ProcessOwnershipHost = systemHost,
  captureBaseline?: ProcessOwnershipBaseline,
): Promise<ProcessCleanupResult> => {
  const processTable = await readLiveProcessTable(host);
  if (!processTable.available)
    return {
      cleaned: false,
      reason: `process table could not be inspected: ${processTable.reason}`,
    };
  const scan = await scanTokenOwnedProcesses(
    processTable.processes,
    runId,
    host,
    captureBaseline,
  );
  if (scan.failures.length > 0) return cleanupValidationFailure(scan.failures);
  return scan.owned.length === 0
    ? { cleaned: true, signaled: false }
    : { cleaned: false, reason: "token-owned process remained after cleanup" };
};

const readLiveProcessTable = async (
  host: ProcessOwnershipHost,
): Promise<
  | {
      readonly available: true;
      readonly processes: readonly ProcessTableEntry[];
    }
  | { readonly available: false; readonly reason: string }
> => {
  try {
    return {
      available: true,
      processes: liveProcesses(await host.listProcesses()),
    };
  } catch (cause: unknown) {
    return { available: false, reason: errorMessage(cause) };
  }
};

interface OwnedCleanupPlan {
  readonly signalOrder: readonly number[];
  readonly tokenOwnedIdentities: ReadonlyMap<number, string | null>;
  readonly unresolved: readonly ProcessOwnershipValidationFailure[];
}

const createOwnedCleanupPlan = async (
  ownership: OwnedProcessGroup,
  processes: readonly ProcessTableEntry[],
  host: ProcessOwnershipHost,
): Promise<OwnedCleanupPlan | ProcessCleanupResult> => {
  const tokenOwned =
    ownership.sweepTokenOwnedProcesses === true
      ? await scanTokenOwnedProcesses(
          processes,
          ownership.runId,
          host,
          ownership.captureBaseline,
        )
      : { owned: [], failures: [], identities: new Map() };
  const tokenOwnedGroupIds = new Set(
    tokenOwned.owned.map(({ processGroupId }) => processGroupId),
  );
  const launcher = processes.find(({ pid }) => pid === ownership.leaderPid);
  const rootMembers = processes.filter(
    ({ processGroupId }) => processGroupId === ownership.processGroupId,
  );
  if (
    launcher === undefined &&
    rootMembers.length === 0 &&
    tokenOwned.owned.length === 0
  )
    return tokenOwned.failures.length > 0
      ? {
          signalOrder: [],
          tokenOwnedIdentities: tokenOwned.identities,
          unresolved: tokenOwned.failures,
        }
      : { cleaned: true, signaled: false };
  let descendants: readonly ProcessTableEntry[] = [];
  if (launcher !== undefined) {
    const identityFailure = launcherIdentityFailure(launcher, ownership);
    if (identityFailure !== null)
      return { cleaned: false, reason: identityFailure };
    descendants = descendantsOf(launcher.pid, processes);
  }
  const descendantPids = new Set(descendants.map(({ pid }) => pid));
  const processGroupIds = new Set<number>([ownership.processGroupId]);
  for (const descendant of descendants)
    processGroupIds.add(descendant.processGroupId);
  for (const process of tokenOwned.owned)
    processGroupIds.add(process.processGroupId);
  for (const processGroupId of processGroupIds) {
    if (processGroupId === ownership.processGroupId) continue;
    const groupLeader = processes.find(
      ({ pid, processGroupId: observedGroupId }) =>
        pid === processGroupId && observedGroupId === processGroupId,
    );
    if (
      (groupLeader === undefined || !descendantPids.has(groupLeader.pid)) &&
      !tokenOwnedGroupIds.has(processGroupId)
    )
      return {
        cleaned: false,
        reason:
          "descendant process-group leader identity could not be verified",
      };
  }
  const liveMembers = processes.filter(({ processGroupId }) =>
    processGroupIds.has(processGroupId),
  );
  const failures = await processOwnershipFailures(
    liveMembers,
    ownership.runId,
    host,
    tokenOwned.identities,
  );
  if (failures.length > 0) return cleanupValidationFailure(failures);
  return {
    signalOrder: [ownership.processGroupId].concat(
      [...processGroupIds]
        .filter((processGroupId) => processGroupId !== ownership.processGroupId)
        .sort((left, right) => left - right),
    ),
    tokenOwnedIdentities: tokenOwned.identities,
    unresolved: tokenOwned.failures,
  };
};

const revalidateOwnedProcessGroup = async (
  processGroupId: number,
  ownership: OwnedProcessGroup,
  host: ProcessOwnershipHost,
  expectedIdentities: ReadonlyMap<number, string | null>,
): Promise<{ readonly empty: boolean } | ProcessCleanupResult> => {
  let members: readonly ProcessTableEntry[];
  try {
    members = liveProcesses(await host.listProcesses()).filter(
      ({ processGroupId: observedGroupId }) =>
        observedGroupId === processGroupId,
    );
  } catch (cause: unknown) {
    return {
      cleaned: false,
      reason: `process ownership could not be revalidated: ${errorMessage(cause)}`,
    };
  }
  const failures = await processOwnershipFailures(
    members,
    ownership.runId,
    host,
    expectedIdentities,
  );
  if (failures.length > 0) return cleanupValidationFailure(failures);
  if (processGroupId === ownership.processGroupId) {
    const launcher = members.find(({ pid }) => pid === ownership.leaderPid);
    if (launcher !== undefined) {
      const identityFailure = launcherIdentityFailure(launcher, ownership);
      if (identityFailure !== null)
        return { cleaned: false, reason: identityFailure };
    }
  }
  if (
    processGroupId !== ownership.processGroupId &&
    members.length > 0 &&
    !members.some(({ pid }) => pid === processGroupId) &&
    ownership.sweepTokenOwnedProcesses !== true
  )
    return {
      cleaned: false,
      reason:
        "descendant process-group leader identity could not be revalidated",
    };
  return { empty: members.length === 0 };
};

const cleanupValidationFailure = (
  failures: readonly ProcessOwnershipValidationFailure[],
): ProcessCleanupResult => {
  const unreadable = failures.filter(
    ({ reason }) => reason === "environment-unreadable",
  );
  if (failures.some(({ reason }) => reason === "run-token-mismatch"))
    return {
      cleaned: false,
      reason: "process tree contains an unowned or PID-reused process",
      failures,
    };
  if (failures.some(({ reason }) => reason === "process-identity-unavailable"))
    return {
      cleaned: false,
      reason: "process identity could not be revalidated",
      failures,
    };
  if (unreadable.length > 0) {
    const counts = new Map<string, number>();
    for (const { diagnostic } of unreadable) {
      const category = sanitizedTokenReadFailure(diagnostic);
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }
    const breakdown = [...counts]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([category, count]) => `${category}=${String(count)}`)
      .join(", ");
    return {
      cleaned: false,
      reason: `process ownership token could not be read for ${String(unreadable.length)} live process(es): ${breakdown}`,
      failures,
    };
  }
  return {
    cleaned: false,
    reason: "process ownership could not be revalidated",
    failures,
  };
};

const sanitizedTokenReadFailure = (diagnostic: string | undefined): string => {
  if (diagnostic === "environment_unavailable") return diagnostic;
  if (diagnostic === "apple_vector_unavailable") return diagnostic;
  if (diagnostic === "ambiguous_environment_boundary") return diagnostic;
  if (diagnostic === "malformed_procargs") return diagnostic;
  if (diagnostic === "process_identity_changed_during_token_read")
    return diagnostic;
  if (diagnostic === "process_not_in_snapshot") return diagnostic;
  const processTableFailure = /^process_table_failed_(\d+)$/u.exec(
    diagnostic ?? "",
  );
  if (processTableFailure?.[1] !== undefined)
    return `process_table_errno_${processTableFailure[1]}`;
  const sysctlFailure = /^sysctl_failed_(\d+)$/u.exec(diagnostic ?? "");
  if (sysctlFailure?.[1] !== undefined)
    return `sysctl_errno_${sysctlFailure[1]}`;
  if (diagnostic === "reader_failure") return diagnostic;
  if (diagnostic === "duplicate_run_token") return diagnostic;
  if (diagnostic === "invalid_run_token_encoding") return diagnostic;
  return "other_unavailable";
};

const processOwnershipFailures = async (
  members: readonly ProcessTableEntry[],
  runId: string,
  host: ProcessOwnershipHost,
  expectedIdentities: ReadonlyMap<number, string | null> = new Map(),
): Promise<readonly ProcessOwnershipValidationFailure[]> => {
  const failures: ProcessOwnershipValidationFailure[] = [];
  if (expectedIdentities.size > 0 && host.processIdentities !== undefined) {
    const expectedMembers = members.filter(({ pid }) =>
      expectedIdentities.has(pid),
    );
    const observed = await host.processIdentities(expectedMembers);
    for (const member of expectedMembers) {
      const expected = expectedIdentities.get(member.pid);
      const current = observed.get(member.pid);
      if (
        expected === null ||
        current?.state !== "readable" ||
        current.identity !== expected
      ) {
        if (await processIsGone(host, member.pid)) continue;
        failures.push({
          pid: member.pid,
          reason: "process-identity-unavailable",
          diagnostic:
            "process identity changed or became unavailable before signal",
        });
      }
    }
  }
  for (const member of members) {
    try {
      if ((await host.environment(member.pid)).REA_PROCESS_RUN_ID !== runId)
        failures.push({ pid: member.pid, reason: "run-token-mismatch" });
    } catch (cause: unknown) {
      try {
        const live = liveProcesses(await host.listProcesses());
        if (!live.some(({ pid }) => pid === member.pid)) continue;
      } catch (recheckCause: unknown) {
        failures.push({
          pid: member.pid,
          reason: "environment-unreadable",
          diagnostic: `${errorMessage(cause)}; process liveness recheck failed: ${errorMessage(recheckCause)}`,
        });
        continue;
      }
      failures.push({
        pid: member.pid,
        reason: "environment-unreadable",
        diagnostic: errorMessage(cause),
      });
    }
  }
  if (
    failures.length === 0 &&
    expectedIdentities.size > 0 &&
    host.processIdentities !== undefined
  ) {
    const expectedMembers = members.filter(({ pid }) =>
      expectedIdentities.has(pid),
    );
    const observed = await host.processIdentities(expectedMembers);
    for (const member of expectedMembers) {
      const expected = expectedIdentities.get(member.pid);
      const current = observed.get(member.pid);
      if (
        expected !== null &&
        current?.state === "readable" &&
        current.identity === expected
      )
        continue;
      if (await processIsGone(host, member.pid)) continue;
      failures.push({
        pid: member.pid,
        reason: "process-identity-unavailable",
        diagnostic:
          "process identity changed or became unavailable during token validation",
      });
    }
  }
  return failures;
};

interface TokenOwnedProcessScan {
  readonly owned: readonly ProcessTableEntry[];
  readonly failures: readonly ProcessOwnershipValidationFailure[];
  readonly identities: ReadonlyMap<number, string | null>;
}

const scanTokenOwnedProcesses = async (
  processes: readonly ProcessTableEntry[],
  runId: string,
  host: ProcessOwnershipHost,
  captureBaseline?: ProcessOwnershipBaseline,
): Promise<TokenOwnedProcessScan> => {
  let candidates = processes;
  let candidateIdentities: ReadonlyMap<number, ProcessIdentityObservation> =
    new Map();
  if (host.processIdentities !== undefined) {
    const current = await host.processIdentities(processes);
    candidateIdentities = current;
    if (captureBaseline !== undefined) {
      const baseline = new Map(
        captureBaseline.map(({ pid, identity }) => [pid, identity]),
      );
      candidates = processes.filter((process) => {
        const before = baseline.get(process.pid);
        const now = current.get(process.pid);
        return !(
          before !== undefined &&
          before !== null &&
          now?.state === "readable" &&
          now.identity === before
        );
      });
    }
  }
  const failures: ProcessOwnershipValidationFailure[] = [];
  if (captureBaseline !== undefined && host.processIdentities !== undefined) {
    const stableCandidates: ProcessTableEntry[] = [];
    for (const process of candidates) {
      if (candidateIdentities.get(process.pid)?.state === "readable") {
        stableCandidates.push(process);
        continue;
      }
      if (!(await processIsGone(host, process.pid)))
        failures.push({
          pid: process.pid,
          reason: "process-identity-unavailable",
          diagnostic: "process identity was unavailable during token scan",
        });
    }
    candidates = stableCandidates;
  }
  let bulkTokens: ReadonlyMap<number, ProcessRunTokenObservation> | undefined;
  if (host.runTokens !== undefined)
    bulkTokens = await host.runTokens(candidates);
  const owned: ProcessTableEntry[] = [];
  const ownedIdentities = new Map<number, string | null>();
  for (const process of candidates) {
    const bulkToken = bulkTokens?.get(process.pid);
    if (bulkToken !== undefined) {
      if (bulkToken.state === "readable") {
        if (bulkToken.runId === runId) {
          owned.push(process);
          const identity = candidateIdentities.get(process.pid);
          ownedIdentities.set(
            process.pid,
            identity?.state === "readable" ? identity.identity : null,
          );
        }
        continue;
      }
      if (!(await processIsGone(host, process.pid)))
        failures.push({
          pid: process.pid,
          reason: "environment-unreadable",
          diagnostic: bulkToken.reason,
        });
      continue;
    }
    try {
      if ((await host.environment(process.pid)).REA_PROCESS_RUN_ID === runId) {
        owned.push(process);
        const identity = candidateIdentities.get(process.pid);
        ownedIdentities.set(
          process.pid,
          identity?.state === "readable" ? identity.identity : null,
        );
      }
    } catch (cause: unknown) {
      try {
        const live = liveProcesses(await host.listProcesses());
        if (!live.some(({ pid }) => pid === process.pid)) continue;
      } catch (recheckCause: unknown) {
        failures.push({
          pid: process.pid,
          reason: "environment-unreadable",
          diagnostic: `${errorMessage(cause)}; process liveness recheck failed: ${errorMessage(recheckCause)}`,
        });
        continue;
      }
      failures.push({
        pid: process.pid,
        reason: "environment-unreadable",
        diagnostic: errorMessage(cause),
      });
    }
  }
  if (candidates.length > 0 && host.processIdentities !== undefined) {
    const afterRead = await host.processIdentities(candidates);
    const stillOwned: ProcessTableEntry[] = [];
    const ownedPids = new Set(owned.map(({ pid }) => pid));
    for (const process of candidates) {
      const before = candidateIdentities.get(process.pid);
      const current = afterRead.get(process.pid);
      if (
        before?.state === "readable" &&
        current?.state === "readable" &&
        current.identity === before.identity
      ) {
        if (ownedPids.has(process.pid)) stillOwned.push(process);
        continue;
      }
      if (await processIsGone(host, process.pid)) continue;
      failures.push({
        pid: process.pid,
        reason: "process-identity-unavailable",
        diagnostic:
          "process identity changed or became unavailable during token validation",
      });
    }
    return { owned: stillOwned, failures, identities: ownedIdentities };
  }
  return { owned, failures, identities: ownedIdentities };
};

const processIsGone = async (
  host: ProcessOwnershipHost,
  pid: number,
): Promise<boolean> => {
  try {
    return !liveProcesses(await host.listProcesses()).some(
      (process) => process.pid === pid,
    );
  } catch (cause: unknown) {
    void cause;
    return false;
  }
};
