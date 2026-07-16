import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

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

/** One operating-system observation of a process-group member. */
interface ProcessGroupMember {
  readonly pid: number;
  readonly parentPid: number;
  readonly processGroupId: number;
  readonly state: string;
  readonly command: string;
}

/** Narrow operating-system seam used to inspect and signal process groups. */
export interface ProcessOwnershipHost {
  listMembers(processGroupId: number): Promise<
    readonly {
      readonly pid: number;
      readonly parentPid: number;
      readonly processGroupId: number;
      readonly state: string;
      readonly command: string;
    }[]
  >;
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
  async listMembers(processGroupId) {
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
      }))
      .filter((member) => member.processGroupId === processGroupId);
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

/**
 * Verify run-token ownership before signaling a POSIX process group.
 *
 * Process IDs and group IDs can be reused. REA therefore re-reads every live
 * member's environment immediately before signaling and fails closed if any
 * member cannot be inspected or lacks the per-capture run token.
 */
export const cleanupOwnedProcessGroup = async (
  ownership: OwnedProcessGroup,
  host: ProcessOwnershipHost = systemHost,
): Promise<ProcessCleanupResult> => {
  let members: readonly ProcessGroupMember[];
  try {
    members = await host.listMembers(ownership.processGroupId);
  } catch {
    return { cleaned: false, reason: "process group could not be inspected" };
  }
  const liveMembers = liveProcessGroupMembers(members);
  if (liveMembers.length === 0) return { cleaned: true, signaled: false };
  const leader = liveMembers.find(
    (member) => member.pid === ownership.leaderPid,
  );
  if (leader !== undefined) {
    if (
      ownership.expectedParentPid !== undefined &&
      leader.parentPid !== ownership.expectedParentPid
    )
      return {
        cleaned: false,
        reason: "owned launcher parent identity did not match",
      };
    if (
      ownership.expectedCommand !== undefined &&
      !commandMatches(leader.command, ownership.expectedCommand)
    )
      return {
        cleaned: false,
        reason: "owned launcher command identity did not match",
      };
  }
  const failures: ProcessOwnershipValidationFailure[] = [];
  for (const member of liveMembers) {
    try {
      const environment = await host.environment(member.pid);
      if (environment.REA_PROCESS_RUN_ID !== ownership.runId)
        failures.push({ pid: member.pid, reason: "run-token-mismatch" });
    } catch {
      failures.push({ pid: member.pid, reason: "environment-unreadable" });
    }
  }
  if (failures.length > 0)
    return {
      cleaned: false,
      reason: failures.some(({ reason }) => reason === "run-token-mismatch")
        ? "process group contains an unowned or PID-reused process"
        : "process ownership could not be revalidated",
      failures,
    };
  try {
    host.signalGroup(ownership.processGroupId, "SIGKILL");
  } catch (cause: unknown) {
    const code =
      cause instanceof Error && "code" in cause ? cause.code : undefined;
    if (code !== "ESRCH")
      return { cleaned: false, reason: "owned process group signal failed" };
  }
  return { cleaned: true, signaled: true };
};

/** Observe one group without signaling it, failing closed on identity doubt. */
export const observeOwnedProcessGroup = async (
  ownership: OwnedProcessGroup,
  host: ProcessOwnershipHost = systemHost,
): Promise<ProcessGroupObservation> => {
  let members: readonly ProcessGroupMember[];
  try {
    members = await host.listMembers(ownership.processGroupId);
  } catch {
    return {
      state: "unverifiable",
      reason: "process group could not be inspected",
    };
  }
  const liveMembers = liveProcessGroupMembers(members);
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

const liveProcessGroupMembers = (
  members: readonly ProcessGroupMember[],
): readonly ProcessGroupMember[] =>
  members.filter(({ state }) => !state.startsWith("Z"));

const commandMatches = (actual: string, expected: string): boolean => {
  const normalizedActual = actual.trim();
  const normalizedExpected = expected.trim();
  return (
    normalizedActual === normalizedExpected ||
    normalizedActual.startsWith(`${normalizedExpected} `)
  );
};
