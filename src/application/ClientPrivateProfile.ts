import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { dirname } from "node:path";

import {
  AnalysisCleanupLease,
  AnalysisCleanupLeaseGroup,
  type ArtifactResourceScope,
} from "../resources/index.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import { RegularFileChangedError } from "../filesystem/RegularFile.js";
import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";

/**
 * A client profile only its owner may read, such as fx's `~/.fx`: the folder
 * is 0700 and the configuration file 0600. Setup and `rea mcp add` publish it
 * through this one owner.
 */
export const PRIVATE_PROFILE_MODES = {
  directory: 0o700,
  file: 0o600,
} as const;

export type PrivateProfilePermissions =
  | {
      readonly kind: "verified_posix_modes";
      readonly directoryMode: 0o700;
      readonly fileMode: 0o600;
    }
  | {
      readonly kind: "requested_windows_modes";
      readonly requestedDirectoryMode: 0o700;
      readonly requestedFileMode: 0o600;
      readonly aclVerification: "unavailable";
    };

/**
 * Whether an existing private profile already has its modes. Windows ACLs
 * cannot be verified through mode bits, so only POSIX modes are compared.
 */
export const privateProfileModesCurrent = async (
  configPath: string,
  platform: NodeJS.Platform,
): Promise<boolean> => {
  if (platform === "win32") return true;
  // Setup and `rea mcp add` publish a linked profile at its canonical path,
  // so the modes that count are those of the file and folder it names.
  const target = await realpath(configPath);
  const [file, directory] = await Promise.all([
    stat(target),
    stat(dirname(target)),
  ]);
  return (
    (file.mode & 0o777) === PRIVATE_PROFILE_MODES.file &&
    (directory.mode & 0o777) === PRIVATE_PROFILE_MODES.directory
  );
};

/** Apply the private folder mode through the selected directory descriptor. */
export const securePrivateDirectory = async (
  path: string,
  home: string,
  checkCancellation: () => void,
  resources: ArtifactResourceScope | undefined,
): Promise<boolean> => {
  const owner = new OwnedFileHandle(
    await open(
      path,
      constants.O_RDONLY |
        (constants.O_DIRECTORY ?? 0) |
        (constants.O_NOFOLLOW ?? 0),
    ),
  );
  const lease = AnalysisCleanupLease.forCloseOwner(owner, path);
  let primary: unknown;
  let changed = false;
  try {
    const before = await owner.handle.stat();
    const named = await lstat(path);
    if (
      !before.isDirectory() ||
      named.isSymbolicLink() ||
      before.ino === 0 ||
      before.dev !== named.dev ||
      before.ino !== named.ino ||
      !named.isDirectory()
    )
      throw new RegularFileChangedError(path);
    // A linked parent can make a profile path name the home folder itself.
    const homeFolder = await stat(home);
    if (homeFolder.dev === before.dev && homeFolder.ino === before.ino)
      throw new ConfigurationError(
        `The private profile folder ${path} is the home folder; REA will not make the home folder private. Point the client at its own profile folder; no settings were written.`,
      );
    changed = (before.mode & 0o777) !== PRIVATE_PROFILE_MODES.directory;
    checkCancellation();
    if (changed) await owner.handle.chmod(PRIVATE_PROFILE_MODES.directory);
    const after = await owner.handle.stat();
    const current = await lstat(path);
    if (
      (after.mode & 0o777) !== PRIVATE_PROFILE_MODES.directory ||
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      current.dev !== after.dev ||
      current.ino !== after.ino
    )
      throw new RegularFileChangedError(path);
  } catch (cause: unknown) {
    primary = cause;
  }
  try {
    await lease.release();
  } catch (cause: unknown) {
    const error = new ConfigurationError(
      `Private client directory cleanup failed at ${path}`,
      {
        cause:
          primary === undefined
            ? cause
            : new AggregateError(
                [primary, cause],
                "Private profile permission operation and directory cleanup failed",
              ),
        cleanup: {
          reason: "Private profile directory handle could not be closed",
          resources: [path],
        },
      },
    );
    new AnalysisCleanupLeaseGroup(error, [lease]);
    resources?.retain({ kind: "lease", resource: path, lease });
    throw error;
  }
  if (primary !== undefined) throw primary;
  return changed;
};

/** Mode requests cannot establish Windows ACL privacy on `platform`. */
export const privateProfilePermissions = (
  platform: NodeJS.Platform,
): PrivateProfilePermissions =>
  platform === "win32"
    ? {
        kind: "requested_windows_modes",
        requestedDirectoryMode: PRIVATE_PROFILE_MODES.directory,
        requestedFileMode: PRIVATE_PROFILE_MODES.file,
        aclVerification: "unavailable",
      }
    : {
        kind: "verified_posix_modes",
        directoryMode: PRIVATE_PROFILE_MODES.directory,
        fileMode: PRIVATE_PROFILE_MODES.file,
      };
