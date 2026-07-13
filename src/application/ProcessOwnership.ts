import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Identity proof required before REA may signal a captured process group. */
export interface OwnedProcessGroup {
  readonly runId: string;
  readonly leaderPid: number;
  readonly processGroupId: number;
  /** Expected launcher identity, checked only while the leader exists. */
  readonly expectedCommand?: string;
  /** Expected launcher parent, checked only while the leader exists. */
  readonly expectedParentPid?: number;
}

interface ProcessGroupMember {
  readonly pid: number;
  readonly parentPid: number;
  readonly processGroupId: number;
  readonly command: string;
}

/** Narrow operating-system seam used to inspect and signal process groups. */
export interface ProcessOwnershipHost {
  listMembers(processGroupId: number): Promise<readonly ProcessGroupMember[]>;
  environment(pid: number): Promise<Readonly<Record<string, string>>>;
  signalGroup(processGroupId: number, signal: NodeJS.Signals): void;
}

/** Cleanup succeeds only when the group is absent or every member is owned. */
export type ProcessCleanupResult =
  | { readonly cleaned: true; readonly signaled: boolean }
  | { readonly cleaned: false; readonly reason: string };

/** Token-verified liveness result used by post-root-exit settlement. */
export type ProcessGroupObservation =
  | { readonly state: "empty" }
  | { readonly state: "alive" }
  | { readonly state: "unverifiable"; readonly reason: string };

const parseEnvironment = (value: string): Readonly<Record<string, string>> =>
  Object.fromEntries(
    value
      .split("\0")
      .filter((entry) => entry.includes("="))
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
      "pid=,ppid=,pgid=,command=",
    ]);
    return stdout
      .split("\n")
      .map((line) => /\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)/u.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => ({
        pid: Number(match[1]),
        parentPid: Number(match[2]),
        processGroupId: Number(match[3]),
        command: match[4] ?? "",
      }))
      .filter((member) => member.processGroupId === processGroupId);
  },
  async environment(pid) {
    if (process.platform === "linux") {
      return parseEnvironment(await readFile(`/proc/${pid}/environ`, "utf8"));
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
  if (members.length === 0) return { cleaned: true, signaled: false };
  const leader = members.find((member) => member.pid === ownership.leaderPid);
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
  for (const member of members) {
    let environment: Readonly<Record<string, string>>;
    try {
      environment = await host.environment(member.pid);
    } catch {
      return {
        cleaned: false,
        reason: "process ownership could not be revalidated",
      };
    }
    if (environment.REA_PROCESS_RUN_ID !== ownership.runId) {
      return {
        cleaned: false,
        reason: "process group contains an unowned or PID-reused process",
      };
    }
  }
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
  if (members.length === 0) return { state: "empty" };
  for (const member of members) {
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

const commandMatches = (actual: string, expected: string): boolean => {
  const normalizedActual = actual.trim();
  const normalizedExpected = expected.trim();
  return (
    normalizedActual === normalizedExpected ||
    normalizedActual.startsWith(`${normalizedExpected} `)
  );
};
