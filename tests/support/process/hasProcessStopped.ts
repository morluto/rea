import { observePosixProcess } from "./observePosixProcess.js";

/**
 * Report whether a process the test stopped no longer runs.
 *
 * Signal 0 succeeds for a zombie, so a descendant that was killed but waits for
 * a PID 1 that does not reap promptly (a container without an init) would read
 * as alive. On POSIX hosts a zombie therefore counts as stopped. Windows has no
 * zombies, so signal 0 remains the observation there.
 */
export const hasProcessStopped = async (pid: number): Promise<boolean> => {
  if (process.platform === "win32") {
    try {
      process.kill(pid, 0);
      return false;
    } catch (cause: unknown) {
      if (cause instanceof Error && "code" in cause && cause.code === "ESRCH")
        return true;
      throw cause;
    }
  }
  return (await observePosixProcess(pid)).kind !== "running";
};
