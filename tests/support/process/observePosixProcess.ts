import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Observable POSIX process state; unknown states remain rejected by the caller. */
export type PosixProcessObservation =
  | { readonly kind: "absent" }
  | { readonly kind: "zombie"; readonly state: string }
  | { readonly kind: "running"; readonly state: string };

/** Observe one PID with ps without signaling it or treating checker faults as absence. */
export const observePosixProcess = async (
  pid: number,
): Promise<PosixProcessObservation> => {
  let stdout: string;
  try {
    const result = await execFileAsync("ps", [
      "-o",
      "stat=",
      "-p",
      String(pid),
    ]);
    if (result.stderr !== "")
      throw new Error(
        `Process observation emitted diagnostics: ${result.stderr}`,
      );
    stdout = result.stdout;
  } catch (cause: unknown) {
    if (
      cause instanceof Error &&
      "code" in cause &&
      cause.code === 1 &&
      "stdout" in cause &&
      typeof cause.stdout === "string" &&
      cause.stdout.trim() === "" &&
      "stderr" in cause &&
      cause.stderr === ""
    )
      return { kind: "absent" };
    throw cause;
  }

  const state = stdout.trim();
  if (state === "") return { kind: "absent" };
  return state.startsWith("Z")
    ? { kind: "zombie", state }
    : { kind: "running", state };
};

/**
 * Whether a process has stopped. A POSIX zombie has exited and only waits to
 * be reaped, so it counts as stopped although signal 0 still reaches it.
 * Windows has no zombie state, so signal 0 answers there.
 */
export const processHasStopped = async (pid: number): Promise<boolean> => {
  if (process.platform !== "win32")
    return (await observePosixProcess(pid)).kind !== "running";
  try {
    process.kill(pid, 0);
    return false;
  } catch (cause: unknown) {
    if (cause instanceof Error && "code" in cause && cause.code === "ESRCH")
      return true;
    throw cause;
  }
};

/** One member of a POSIX process group as ps reports it. */
export interface PosixProcessGroupMember {
  readonly pid: number;
  readonly kind: "zombie" | "running";
  readonly state: string;
}

/**
 * Observe the members of one process group with ps, without signaling it.
 * Signal 0 to a group still succeeds while an exited member waits to be reaped
 * (by PID 1 once orphaned), so zombies are reported rather than counted live.
 * An empty list means no member remains.
 */
export const observePosixProcessGroup = async (
  processGroupId: number,
): Promise<readonly PosixProcessGroupMember[]> => {
  const { stdout, stderr } = await execFileAsync("ps", [
    "-A",
    "-o",
    "pid=,pgid=,stat=",
  ]);
  if (stderr !== "")
    throw new Error(`Process observation emitted diagnostics: ${stderr}`);
  const members: PosixProcessGroupMember[] = [];
  for (const line of stdout.split("\n")) {
    const row = line.trim();
    if (row === "") continue;
    const fields = /^(?<pid>\d+)\s+(?<group>\d+)\s+(?<state>\S+)$/u.exec(
      row,
    )?.groups;
    if (
      fields?.pid === undefined ||
      fields.group === undefined ||
      fields.state === undefined
    )
      throw new Error(`Process observation row is not "pid pgid stat": ${row}`);
    if (Number(fields.group) !== processGroupId) continue;
    members.push({
      pid: Number(fields.pid),
      kind: fields.state.startsWith("Z") ? "zombie" : "running",
      state: fields.state,
    });
  }
  return members;
};
