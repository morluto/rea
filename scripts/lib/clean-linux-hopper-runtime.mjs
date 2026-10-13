import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, stat } from "node:fs/promises";

const execFileAsync = promisify(execFile);

/**
 * Observe leftover demo processes on a dedicated clean Linux runner, including
 * groups reparented after their launcher exits. This is not ownership proof and
 * never authorizes signaling; unrelated runtime processes also block this lane.
 */
export const assertCleanLinuxHopperRuntime = async (
  launcherPaths = [
    "/opt/hopper/bin/Hopper",
    ...(process.env.HOPPER_LAUNCHER_PATH === undefined
      ? []
      : [process.env.HOPPER_LAUNCHER_PATH]),
  ],
) => {
  const { stdout } = await execFileAsync("ps", ["-ax", "-o", "command="]);
  if (/\/opt\/hopper\/bin\/Hopper|\bXvfb\b|hopper-demo-x11\.py/u.test(stdout))
    throw new Error("Clean Linux runner retained a Hopper demo process");
  const launchers = [];
  for (const path of launcherPaths) {
    try {
      launchers.push(await stat(path, { bigint: true }));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  if (launchers.length === 0) return;
  // /proc exposes the executed file even when argv[0] names a removed symlink.
  // Compare file identity, not a display path or a process name.
  let inspectionError;
  for (const entry of await readdir("/proc", { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
    let executable;
    try {
      executable = await stat(`/proc/${entry.name}/exe`, { bigint: true });
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ESRCH") continue;
      // Other users' executables may be unreadable. The setup lane launches
      // providers as the caller; unreadable caller-owned processes fail closed.
      if (error?.code === "EACCES") {
        const owner = await stat(`/proc/${entry.name}`).catch((cause) => {
          if (cause?.code === "ENOENT") return undefined;
          throw cause;
        });
        if (owner === undefined || owner.uid !== process.getuid()) continue;
      }
      // Finish the inventory so an unrelated restricted process cannot mask a
      // positively identified leak. Unknown caller processes still fail closed.
      inspectionError ??= error;
      continue;
    }
    if (
      launchers.some(
        ({ dev, ino }) => dev === executable.dev && ino === executable.ino,
      )
    )
      throw new Error("Clean Linux runner retained a Hopper demo process");
  }
  if (inspectionError !== undefined) throw inspectionError;
};
