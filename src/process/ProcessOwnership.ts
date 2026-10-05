import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  createSystemProcessOwnershipHost,
  errorMessage,
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
}

/** One entry from an operating-system process-table snapshot. */
export interface ProcessTableEntry {
  readonly pid: number;
  readonly parentPid: number;
  readonly processGroupId: number;
  readonly state: string;
  readonly command: string;
}

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
  listProcesses(): Promise<readonly ProcessTableEntry[]>;
  environment(pid: number): Promise<Readonly<Record<string, string>>>;
  signalGroup(processGroupId: number, signal: NodeJS.Signals): void;
}

/** Narrow Windows P0 seam for bounded process-tree termination. */
export interface WindowsProcessTreeHost {
  terminateTree(rootPid: number): Promise<"terminated" | "missing">;
}

/** Per-member reason that token-verified cleanup failed closed. */
interface ProcessOwnershipValidationFailure {
  readonly pid: number;
  readonly reason: "environment-unreadable" | "run-token-mismatch";
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
        readonly reason: "environment-unreadable" | "run-token-mismatch";
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

const systemHost = createSystemProcessOwnershipHost();

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
  return { cleaned: true, signaled };
};

/** Verify that no live process still carries an owned capture run token. */
export const verifyNoTokenOwnedProcesses = async (
  runId: string,
  host: ProcessOwnershipHost = systemHost,
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
}

const createOwnedCleanupPlan = async (
  ownership: OwnedProcessGroup,
  processes: readonly ProcessTableEntry[],
  host: ProcessOwnershipHost,
): Promise<OwnedCleanupPlan | ProcessCleanupResult> => {
  const tokenOwned =
    ownership.sweepTokenOwnedProcesses === true
      ? await scanTokenOwnedProcesses(processes, ownership.runId, host)
      : { owned: [], failures: [] };
  if (tokenOwned.failures.length > 0)
    return cleanupValidationFailure(tokenOwned.failures);
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
    return { cleaned: true, signaled: false };
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
  );
  if (failures.length > 0) return cleanupValidationFailure(failures);
  return {
    signalOrder: [ownership.processGroupId].concat(
      [...processGroupIds]
        .filter((processGroupId) => processGroupId !== ownership.processGroupId)
        .sort((left, right) => left - right),
    ),
  };
};

const revalidateOwnedProcessGroup = async (
  processGroupId: number,
  ownership: OwnedProcessGroup,
  host: ProcessOwnershipHost,
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
): ProcessCleanupResult => ({
  cleaned: false,
  reason: failures.some(({ reason }) => reason === "run-token-mismatch")
    ? "process tree contains an unowned or PID-reused process"
    : "process ownership could not be revalidated",
  failures,
});

const processOwnershipFailures = async (
  members: readonly ProcessTableEntry[],
  runId: string,
  host: ProcessOwnershipHost,
): Promise<readonly ProcessOwnershipValidationFailure[]> => {
  const failures: ProcessOwnershipValidationFailure[] = [];
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
  return failures;
};

interface TokenOwnedProcessScan {
  readonly owned: readonly ProcessTableEntry[];
  readonly failures: readonly ProcessOwnershipValidationFailure[];
}

const scanTokenOwnedProcesses = async (
  processes: readonly ProcessTableEntry[],
  runId: string,
  host: ProcessOwnershipHost,
): Promise<TokenOwnedProcessScan> => {
  const owned: ProcessTableEntry[] = [];
  const failures: ProcessOwnershipValidationFailure[] = [];
  for (const process of processes) {
    try {
      if ((await host.environment(process.pid)).REA_PROCESS_RUN_ID === runId)
        owned.push(process);
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
  return { owned, failures };
};
