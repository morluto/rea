import { lstat, realpath, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { absoluteCallerPath } from "./callerPath.js";

/** Resolve existing path components without changing the caller's traversal. */
export const canonicalCallerPath = async (path: string): Promise<string> => {
  const remaining: string[] = [];
  let current = absoluteCallerPath(path);
  for (;;) {
    try {
      const found = await stat(current);
      if (remaining.length > 0 && !found.isDirectory())
        throw Object.assign(
          new Error(`Path parent is not a directory: ${current}`),
          { code: "ENOTDIR" },
        );
      return join(await realpath(current), ...remaining);
    } catch (cause: unknown) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      // A dangling symlink is not an absent destination: its target cannot be
      // established. A missing component followed by .. is likewise unknown.
      const existing = await lstat(current).then(
        () => true,
        (error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        },
      );
      if (
        existing ||
        basename(current) === ".." ||
        dirname(current) === current
      )
        throw cause;
      remaining.unshift(basename(current));
      current = dirname(current);
    }
  }
};
