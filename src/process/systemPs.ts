import { constants } from "node:fs";
import { access } from "node:fs/promises";

/**
 * Fixed system locations REA checks for a Linux `ps`, in order: the
 * conventional FHS paths, then NixOS's system profile. REA's own PATH is only
 * a fallback, so an agent or wrapper PATH cannot hide or replace the `ps`
 * that process ownership and cleanup depend on.
 */
export const LINUX_SYSTEM_PS_LOCATIONS = [
  "/bin/ps",
  "/usr/bin/ps",
  "/run/current-system/sw/bin/ps",
] as const;

/**
 * Arguments of the `ps` run that inventories the process table for ownership
 * checks. The selected `ps` path is its argv[0].
 */
export const PROCESS_INVENTORY_PS_ARGUMENTS = [
  "-axo",
  "pid=,ppid=,pgid=,uid=,stat=,command=",
] as const;

/** FreeBSD ps consumes a custom header through the end of each -o argument. */
export const freeBsdPsColumns = (...columns: readonly string[]): string[] => [
  ...columns.flatMap((column) => ["-o", `${column}=`]),
];

/** The `ps` REA runs to inspect the process table, and where it came from. */
export type SystemPs =
  | { readonly command: string; readonly source: "system" }
  | { readonly command: "ps"; readonly source: "path" };

/** How a diagnostic names the selected `ps`. */
export const describeSystemPs = (ps: SystemPs): string =>
  ps.source === "system"
    ? `ps at ${ps.command}`
    : `ps from REA's PATH (none of ${LINUX_SYSTEM_PS_LOCATIONS.join(", ")} is executable)`;

const executableFile = async (path: string): Promise<boolean> => {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * Select the `ps` for `platform`. macOS ships it at `/bin/ps` on the sealed
 * system volume. Linux uses the first executable fixed system location and
 * falls back to REA's PATH only when none exists. FreeBSD also ships /bin/ps. Other platforms keep PATH.
 */
export const resolveSystemPs = async (
  platform: NodeJS.Platform,
  {
    linuxLocations = LINUX_SYSTEM_PS_LOCATIONS,
    isExecutable = executableFile,
  }: {
    /** Fixed Linux locations; a host without any falls back to PATH. */
    readonly linuxLocations?: readonly string[];
    readonly isExecutable?: (path: string) => Promise<boolean>;
  } = {},
): Promise<SystemPs> => {
  if (platform === "darwin" || platform === "freebsd")
    return { command: "/bin/ps", source: "system" };
  if (platform === "linux")
    for (const command of linuxLocations)
      if (await isExecutable(command)) return { command, source: "system" };
  return { command: "ps", source: "path" };
};
