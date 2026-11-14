import { homedir } from "node:os";
import { mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Create missing parents once, then propagate a failed mkdir to the caller.
 * Node's recursive mkdir can loop on virtual filesystems that return ENOENT
 * for a new entry even though its parent (for example /proc) exists.
 */
export function createDirectoryTree(path: string): void {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (cause) {
    const code =
      cause instanceof Error && "code" in cause ? cause.code : undefined;
    if (code === "EEXIST" && statSync(path).isDirectory()) return;
    const parent = dirname(path);
    if (code !== "ENOENT" || parent === path) throw cause;
    createDirectoryTree(parent);
    // Deliberately nonrecursive: a second ENOENT is a failure, not a retry.
    mkdirSync(path, { mode: 0o700 });
  }
}

/** Root folder for Studio state: database, master key and job workspaces. */
export const studioHome = (env: NodeJS.ProcessEnv = process.env): string =>
  // State belongs to the user at runtime, outside Next's deployment bundle.
  resolve(
    /* turbopackIgnore: true */ env.STUDIO_HOME ||
      join(homedir(), ".rea-studio"),
  );

export const studioPaths = (home: string = studioHome()) => ({
  home,
  database: join(home, "studio.db"),
  masterKey: join(home, "master.key"),
  jobs: join(home, "jobs"),
});
