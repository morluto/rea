import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { matchesOwnedProcessCommand } from "./ProcessCommandIdentity.js";

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
  readonly schemaVersion: 1;
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
 * caller-visible Windows limitations must preserve that distinction.
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
  } catch {
    return {
      cleaned: false,
      reason:
        "Windows P0 process-tree termination failed; Job Object ownership is unavailable",
    };
  }
};

/** Select the PTY root group and groups led by an observed captured process. */
export const selectCapturedProcessGroupIds = (
  rootPid: number,
  samples: readonly {
    readonly pid: number;
    readonly process_group_id: number | null;
  }[],
): readonly number[] => {
  const processGroupIds = new Set<number>([rootPid]);
  for (const sample of samples) {
    // A sampled member may transiently inherit an unrelated group. POSIX group
    // leaders have pid === pgid, so only that observation establishes that the
    // group leader itself belonged to the captured tree. Token checks below
    // remain the final authority immediately before observation or signaling.
    if (sample.pid === sample.process_group_id) processGroupIds.add(sample.pid);
  }
  return [...processGroupIds];
};

/** Parse the NUL-delimited Linux process environment without nameless keys. */
export const parseProcessEnvironment = (
  value: string,
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    value
      .split("\0")
      .filter((entry) => entry.indexOf("=") > 0)
      .map((entry) => {
        const separator = entry.indexOf("=");
        return [entry.slice(0, separator), entry.slice(separator + 1)];
      }),
  );

const systemHost: ProcessOwnershipHost = {
  async listProcesses() {
    if (process.platform === "win32") return [];
    const { stdout } = await execFileAsync("ps", [
      "-axo",
      "pid=,ppid=,pgid=,stat=,command=",
    ]);
    return stdout
      .split("\n")
      .map((line) => /\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)/u.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => ({
        pid: Number(match[1]),
        parentPid: Number(match[2]),
        processGroupId: Number(match[3]),
        state: match[4] ?? "",
        command: match[5] ?? "",
      }));
  },
  async environment(pid) {
    if (process.platform === "linux") {
      return parseProcessEnvironment(
        await readFile(`/proc/${pid}/environ`, "utf8"),
      );
    }
    const { stdout } = await execFileAsync("ps", ["eww", "-p", String(pid)]);
    const environment: Record<string, string> = {};
    for (const match of stdout.matchAll(
      /(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=([^\s]*)/gu,
    ))
      environment[match[1]!] = match[2] ?? "";
    return environment;
  },
  signalGroup(processGroupId, signal) {
    process.kill(-processGroupId, signal);
  },
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
  let processes: readonly ProcessTableEntry[];
  try {
    processes = liveProcesses(await host.listProcesses());
  } catch {
    return { cleaned: false, reason: "process table could not be inspected" };
  }
  const plan = await createOwnedCleanupPlan(ownership, processes, host);
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
        return { cleaned: false, reason: "owned process group signal failed" };
    }
  }
  return { cleaned: true, signaled };
};

interface OwnedCleanupPlan {
  readonly signalOrder: readonly number[];
}

const createOwnedCleanupPlan = async (
  ownership: OwnedProcessGroup,
  processes: readonly ProcessTableEntry[],
  host: ProcessOwnershipHost,
): Promise<OwnedCleanupPlan | ProcessCleanupResult> => {
  const launcher = processes.find(({ pid }) => pid === ownership.leaderPid);
  const rootMembers = processes.filter(
    ({ processGroupId }) => processGroupId === ownership.processGroupId,
  );
  if (launcher === undefined && rootMembers.length === 0)
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
  for (const processGroupId of processGroupIds) {
    if (processGroupId === ownership.processGroupId) continue;
    const groupLeader = processes.find(
      ({ pid, processGroupId: observedGroupId }) =>
        pid === processGroupId && observedGroupId === processGroupId,
    );
    if (groupLeader === undefined || !descendantPids.has(groupLeader.pid))
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

const launcherIdentityFailure = (
  launcher: ProcessTableEntry,
  ownership: OwnedProcessGroup,
): string | null => {
  if (launcher.processGroupId !== ownership.processGroupId)
    return "owned launcher process-group identity did not match";
  if (
    ownership.expectedParentPid !== undefined &&
    launcher.parentPid !== ownership.expectedParentPid
  )
    return "owned launcher parent identity did not match";
  if (
    ownership.expectedCommand !== undefined &&
    !matchesOwnedProcessCommand(launcher.command, ownership.expectedCommand)
  )
    return "owned launcher command identity did not match";
  return null;
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
  } catch {
    return {
      cleaned: false,
      reason: "process ownership could not be revalidated",
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
    !members.some(({ pid }) => pid === processGroupId)
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
    } catch {
      failures.push({ pid: member.pid, reason: "environment-unreadable" });
    }
  }
  return failures;
};

/** Observe one group without signaling it, failing closed on identity doubt. */
export const observeOwnedProcessGroup = async (
  ownership: OwnedProcessGroup,
  host: ProcessOwnershipHost = systemHost,
): Promise<ProcessGroupObservation> => {
  let members: readonly ProcessTableEntry[];
  try {
    members = (await host.listProcesses()).filter(
      ({ processGroupId }) => processGroupId === ownership.processGroupId,
    );
  } catch {
    return {
      state: "unverifiable",
      reason: "process group could not be inspected",
    };
  }
  const liveMembers = liveProcesses(members);
  if (liveMembers.length === 0) return { state: "empty" };
  for (const member of liveMembers) {
    try {
      if (
        (await host.environment(member.pid)).REA_PROCESS_RUN_ID !==
        ownership.runId
      )
        return {
          state: "unverifiable",
          reason: "process ownership did not match",
        };
    } catch {
      return {
        state: "unverifiable",
        reason: "process ownership could not be revalidated",
      };
    }
  }
  return { state: "alive" };
};

/**
 * Record the live launcher and descendant lineage after run-token validation.
 *
 * The observation is intentionally point-in-time. A verified empty descendant
 * list means no descendants were live during this observation, not that the
 * run never created a short-lived child.
 */
export const observeOwnedProcessLineage = async (
  ownership: OwnedProcessGroup,
  host: ProcessOwnershipHost = systemHost,
): Promise<ProcessLineageObservation> => {
  let processes: readonly ProcessTableEntry[];
  try {
    processes = liveProcesses(await host.listProcesses());
  } catch {
    return unavailableLineage(
      ownership,
      "process table could not be inspected",
    );
  }
  const launcher = processes.find(({ pid }) => pid === ownership.leaderPid);
  if (launcher === undefined)
    return unavailableLineage(ownership, "owned launcher is not live");
  if (launcher.processGroupId !== ownership.processGroupId)
    return unavailableLineage(
      ownership,
      "owned launcher process-group identity did not match",
    );
  if (
    ownership.expectedParentPid !== undefined &&
    launcher.parentPid !== ownership.expectedParentPid
  )
    return unavailableLineage(
      ownership,
      "owned launcher parent identity did not match",
    );
  if (
    ownership.expectedCommand !== undefined &&
    !matchesOwnedProcessCommand(launcher.command, ownership.expectedCommand)
  )
    return unavailableLineage(
      ownership,
      "owned launcher command identity did not match",
    );
  const descendants = descendantsOf(launcher.pid, processes);
  for (const member of [launcher, ...descendants]) {
    try {
      if (
        (await host.environment(member.pid)).REA_PROCESS_RUN_ID !==
        ownership.runId
      )
        return unavailableLineage(
          ownership,
          "process lineage contains an unowned or PID-reused process",
        );
    } catch {
      return unavailableLineage(
        ownership,
        "process ownership could not be revalidated",
      );
    }
  }
  return {
    status: "verified",
    observedAt: new Date().toISOString(),
    lineage: {
      schemaVersion: 1,
      runId: ownership.runId,
      launcherPid: launcher.pid,
      launcherParentPid: launcher.parentPid,
      processGroupId: launcher.processGroupId,
      descendants: descendants
        .sort((left, right) => left.pid - right.pid)
        .map(({ pid, parentPid, processGroupId }) => ({
          pid,
          parentPid,
          processGroupId,
        })),
    },
  };
};

const descendantsOf = (
  launcherPid: number,
  processes: readonly ProcessTableEntry[],
): ProcessTableEntry[] => {
  const childrenByParent = new Map<number, ProcessTableEntry[]>();
  for (const process of processes) {
    const siblings = childrenByParent.get(process.parentPid) ?? [];
    siblings.push(process);
    childrenByParent.set(process.parentPid, siblings);
  }
  const descendants: ProcessTableEntry[] = [];
  const pending = [...(childrenByParent.get(launcherPid) ?? [])];
  const visited = new Set<number>([launcherPid]);
  for (const process of pending) {
    if (visited.has(process.pid)) continue;
    visited.add(process.pid);
    descendants.push(process);
    pending.push(...(childrenByParent.get(process.pid) ?? []));
  }
  return descendants;
};

const unavailableLineage = (
  ownership: OwnedProcessGroup,
  reason: string,
): Extract<ProcessLineageObservation, { readonly status: "unavailable" }> => ({
  status: "unavailable",
  observedAt: new Date().toISOString(),
  runId: ownership.runId,
  launcherPid: ownership.leaderPid,
  processGroupId: ownership.processGroupId,
  reason,
});

const liveProcesses = (
  members: readonly ProcessTableEntry[],
): readonly ProcessTableEntry[] =>
  members.filter(({ state }) => !state.startsWith("Z"));
