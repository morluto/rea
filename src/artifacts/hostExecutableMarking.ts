import type { BigIntStats, Stats } from "node:fs";
import { extname } from "node:path";

/** Extensions Windows launches directly through CreateProcess or cmd.exe. */
const windowsLaunchableExtensions = new Set([".bat", ".cmd", ".com", ".exe"]);

/**
 * Whether a host filesystem entry carries the host's executable marking.
 *
 * POSIX hosts mark executability with permission bits. Windows has no execute
 * bit (Node reports file modes from the read-only attribute alone), so it marks
 * launchable files by extension instead. A symlink carries no marking on any
 * host: running it runs its target, and its own permission bits do not
 * control that (Linux reports 0777 for every symlink).
 */
export const hostExecutableMarking = (
  path: string,
  metadata: Pick<Stats | BigIntStats, "mode" | "isFile" | "isSymbolicLink">,
  platform: NodeJS.Platform = process.platform,
): boolean =>
  metadata.isSymbolicLink()
    ? false
    : platform === "win32"
      ? metadata.isFile() &&
        windowsLaunchableExtensions.has(extname(path).toLowerCase())
      : typeof metadata.mode === "bigint"
        ? (metadata.mode & 0o111n) !== 0n
        : (metadata.mode & 0o111) !== 0;
