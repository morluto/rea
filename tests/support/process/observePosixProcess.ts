import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect } from "vitest";

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

const signalZeroHasStopped = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (cause: unknown) {
    if (cause instanceof Error && "code" in cause) {
      if (cause.code === "ESRCH") return true;
      if (cause.code === "EPERM") return false;
    }
    throw cause;
  }
};

/**
 * True when the process will never run again: it is absent, or a zombie
 * waiting to be reaped. A signal-0 probe cannot tell those apart from a
 * live process, so a killed descendant in a non-reaping container reads
 * as alive to `process.kill(pid, 0)`.
 */
export const processHasStopped = async (pid: number): Promise<boolean> => {
  if (process.platform === "win32") return signalZeroHasStopped(pid);
  const observation = await observePosixProcess(pid);
  return observation.kind !== "running";
};

/**
 * True when no member of the process group is still running. Lists all
 * processes with `ps -A -o pgid= -o stat=`; the output carries no command
 * name, so process names with spaces cannot break the parse. Falls back
 * to the signal-0 group probe only when `ps` itself is unavailable.
 */
export const processGroupHasStopped = async (
  pgid: number,
): Promise<boolean> => {
  let stdout: string;
  try {
    const result = await execFileAsync("ps", [
      "-A",
      "-o",
      "pgid=",
      "-o",
      "stat=",
    ]);
    if (result.stderr !== "")
      throw new Error(
        `Process group observation emitted diagnostics: ${result.stderr}`,
      );
    stdout = result.stdout;
  } catch (cause: unknown) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return signalZeroHasStopped(-pgid);
    throw cause;
  }

  for (const line of stdout.split("\n")) {
    const [group, state] = line.trim().split(/\s+/);
    if (group === undefined || state === undefined) continue;
    if (Number(group) === pgid && !state.startsWith("Z")) return false;
  }
  return true;
};

/**
 * Poll until `check()` returns a defined value, aborting immediately on
 * terminal inspection errors (such as sandboxed `/bin/ps` `EPERM`) instead of
 * letting Vitest's `expect.poll` spin-retry thrown errors for the full deadline.
 */
export const waitForPosixObservation = async <Value>(
  check: () => Promise<Value | undefined>,
  options?: { readonly interval?: number },
): Promise<Value> => {
  let outcome:
    | { readonly status: "settled"; readonly value: Value }
    | { readonly status: "error"; readonly cause: unknown }
    | undefined;
  const attempt = async (): Promise<"waiting" | "done"> => {
    try {
      const value = await check();
      if (value === undefined) return "waiting";
      outcome = { status: "settled", value };
      return "done";
    } catch (cause: unknown) {
      outcome = { status: "error", cause };
      return "done";
    }
  };
  await (
    options?.interval === undefined
      ? expect.poll(attempt)
      : expect.poll(attempt, { interval: options.interval })
  ).toBe("done");
  if (outcome?.status === "error") throw outcome.cause;
  if (outcome?.status !== "settled")
    throw new Error("POSIX observation poll ended without an outcome");
  return outcome.value;
};

/** Poll until `pid` is absent or zombie, failing fast on checker errors. */
export const waitForPosixProcessStopped = async (
  pid: number,
  options?: { readonly interval?: number },
): Promise<void> => {
  await waitForPosixObservation(
    async () => ((await processHasStopped(pid)) ? true : undefined),
    options,
  );
};
