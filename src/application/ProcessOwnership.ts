import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface OwnedProcessGroup {
  readonly runId: string;
  readonly leaderPid: number;
  readonly processGroupId: number;
}

interface ProcessGroupMember {
  readonly pid: number;
  readonly parentPid: number;
  readonly processGroupId: number;
  readonly command: string;
}

export interface ProcessOwnershipHost {
  listMembers(processGroupId: number): Promise<readonly ProcessGroupMember[]>;
  environment(pid: number): Promise<Readonly<Record<string, string>>>;
  signalGroup(processGroupId: number, signal: NodeJS.Signals): void;
}

export type ProcessCleanupResult =
  | { readonly cleaned: true; readonly signaled: boolean }
  | { readonly cleaned: false; readonly reason: string };

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

/** Verify run-token ownership before signaling a POSIX process group. */
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
