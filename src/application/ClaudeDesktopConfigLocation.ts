import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { err, ok, type Result } from "../domain/result.js";
import {
  windowsAppDataRoots,
  type MsixPackageView,
} from "./MsixPackageStorage.js";

const CONFIG_FILE = "claude_desktop_config.json";

/** Private files compared at most when looking for a redirected AppData view. */
const PROCESS_VIEW_PROBES = 8;

/**
 * Claude Desktop's MSIX package family: package name `Claude` and the
 * publisher ID Windows derives from `CN="Anthropic, PBC", O="Anthropic, PBC",
 * L=San Francisco, S=California, C=US, …`.
 */
export const CLAUDE_DESKTOP_PACKAGE_FAMILY = "Claude_pzs8sxrjxfjjc";

/** `Claude_` plus a 13-character Crockford base32 MSIX publisher ID. */
const CLAUDE_PACKAGE_FAMILY = /^Claude_[0-9a-hjkmnp-tv-z]{13}$/iu;

/** The configuration Claude Desktop reads and the evidence that it is installed. */
export interface ClaudeDesktopLocation {
  readonly configPath: string;
  readonly markerPath: string;
  readonly msixPackage?: MsixPackageView;
}

/** Unresolved Claude Desktop identity, reported instead of guessing a file. */
export interface ClaudeDesktopLocationFailure {
  readonly path: string;
  readonly message: string;
}

/** Synchronous probes; each throws for failures other than absence. */
export interface ClaudeDesktopLocationFileSystem {
  readonly readdir: (path: string) => readonly string[];
  readonly lstat: (path: string) => { isFile(): boolean };
  readonly realpath: (path: string) => string;
}

const systemFileSystem: ClaudeDesktopLocationFileSystem = {
  readdir: (path) => readdirSync(path),
  lstat: (path) => lstatSync(path),
  realpath: (path) => realpathSync.native(path),
};

/**
 * Resolve the `claude_desktop_config.json` that Windows Claude Desktop reads.
 * Without its MSIX package storage, that is the AppData file. With it, the
 * package reads its private copy when one exists and the AppData file
 * otherwise; a new registration goes to the private copy. A `Claude_*`
 * package from another publisher leaves the reader unknown.
 */
export const resolveWindowsClaudeDesktopLocation = (
  home: string,
  env: Readonly<NodeJS.ProcessEnv>,
  fileSystem: ClaudeDesktopLocationFileSystem = systemFileSystem,
): Result<ClaudeDesktopLocation, ClaudeDesktopLocationFailure> => {
  const roots = windowsAppDataRoots(home, env);
  const appDataDirectory = join(roots.roaming, "Claude");
  const appDataConfigPath = join(appDataDirectory, CONFIG_FILE);
  const packagesDirectory = join(roots.local, "Packages");
  let families: readonly string[];
  try {
    families = fileSystem
      .readdir(packagesDirectory)
      .filter((name) => CLAUDE_PACKAGE_FAMILY.test(name));
  } catch (cause: unknown) {
    if (!isMissing(cause))
      return err({
        path: packagesDirectory,
        message: `MSIX package storage ${packagesDirectory} could not be inspected, so REA cannot establish whether Claude Desktop reads ${appDataConfigPath} or a package-private copy: ${errorMessage(cause)}. Repair access to that directory, then rerun.`,
      });
    families = [];
  }
  const foreign = families.filter(
    (name) =>
      name.toLowerCase() !== CLAUDE_DESKTOP_PACKAGE_FAMILY.toLowerCase(),
  );
  if (foreign.length > 0)
    return err({
      path: join(packagesDirectory, foreign[0] ?? ""),
      message: `MSIX package storage ${foreign.map((name) => join(packagesDirectory, name)).join(", ")} uses Claude Desktop's package name with an unrecognized publisher (Claude Desktop is ${CLAUDE_DESKTOP_PACKAGE_FAMILY}). REA cannot establish which ${CONFIG_FILE} that package reads and does not fall back to ${appDataConfigPath}. Remove the unrecognized package, or register REA in the configuration it reads.`,
    });
  const family = families[0];
  if (family === undefined)
    return ok({ configPath: appDataConfigPath, markerPath: appDataDirectory });
  const container = join(packagesDirectory, family);
  const privateDirectory = join(container, "LocalCache", "Roaming", "Claude");
  const privateConfigPath = join(privateDirectory, CONFIG_FILE);
  const privateCopy = present(fileSystem, privateConfigPath);
  if (!privateCopy.ok) return privateCopy;
  const appDataCopy = privateCopy.value
    ? ok(false)
    : present(fileSystem, appDataConfigPath);
  if (!appDataCopy.ok) return appDataCopy;
  return ok({
    configPath:
      privateCopy.value || !appDataCopy.value
        ? privateConfigPath
        : appDataConfigPath,
    markerPath: container,
    msixPackage: {
      packageFamilyName: family,
      privateConfigPath,
      appDataConfigPath,
      virtualizedRoots: [roots.roaming, roots.local],
      processView: processView(
        fileSystem,
        privateDirectory,
        appDataDirectory,
        privateCopy.value,
      ),
    },
  });
};

/**
 * A process the package started sees the package's private files at their
 * AppData paths; any other process sees the real AppData files or nothing.
 * Claude Desktop saves its user data there while it runs, so the
 * configuration, or any other private file, can show which view this is.
 */
const processView = (
  fileSystem: ClaudeDesktopLocationFileSystem,
  privateDirectory: string,
  appDataDirectory: string,
  privateConfig: boolean,
): MsixPackageView["processView"] => {
  let probes: readonly string[];
  try {
    probes = privateConfig
      ? [CONFIG_FILE]
      : fileSystem
          .readdir(privateDirectory)
          .filter((name) => {
            try {
              return fileSystem.lstat(join(privateDirectory, name)).isFile();
            } catch (cause: unknown) {
              // A candidate may vanish or become unreadable while listed.
              void cause;
              return false;
            }
          })
          .slice(0, PROCESS_VIEW_PROBES);
  } catch (cause: unknown) {
    // No private file can be listed, so no view can be compared.
    void cause;
    return "unknown";
  }
  let view: MsixPackageView["processView"] = "unknown";
  for (const name of probes) {
    let privateTarget: string;
    try {
      privateTarget = fileSystem.realpath(join(privateDirectory, name));
    } catch (cause: unknown) {
      // A private file that vanished cannot be compared; try another.
      void cause;
      continue;
    }
    try {
      if (fileSystem.realpath(join(appDataDirectory, name)) === privateTarget)
        return "redirected";
      view = "direct";
    } catch (cause: unknown) {
      if (!isMissing(cause)) return "unknown";
      view = "direct";
    }
  }
  return view;
};

const present = (
  fileSystem: ClaudeDesktopLocationFileSystem,
  path: string,
): Result<boolean, ClaudeDesktopLocationFailure> => {
  try {
    fileSystem.lstat(path);
    return ok(true);
  } catch (cause: unknown) {
    if (isMissing(cause)) return ok(false);
    return err({
      path,
      message: `${path} could not be inspected, so REA cannot establish which ${CONFIG_FILE} Claude Desktop's MSIX package reads: ${errorMessage(cause)}. Repair access to that path, then rerun.`,
    });
  }
};

const isMissing = (cause: unknown): boolean =>
  cause instanceof Error &&
  "code" in cause &&
  (cause.code === "ENOENT" || cause.code === "ENOTDIR");

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);
