import { lstatSync, opendirSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { err, ok, type Result } from "../domain/result.js";
import {
  windowsAppDataRoots,
  type MsixPackageView,
} from "./MsixPackageStorage.js";
import { errorMessage } from "../kernel/errorMessage.js";

const CONFIG_FILE = "claude_desktop_config.json";

/** Private files compared at most when looking for a redirected AppData view. */
const PROCESS_VIEW_PROBES = 8;

/**
 * Bounds of the walk through the package's private roaming root when Claude
 * Desktop's own folder holds no private file: directories listed or waiting
 * to be listed, their depth, entries inspected in all, and files taken from
 * one directory before moving on, so the probes spread across folders instead
 * of filling up from the first one.
 */
const ROAMING_DIRECTORY_LIMIT = 64;
const ROAMING_DEPTH_LIMIT = 4;
const ROAMING_ENTRY_LIMIT = 1024;
const PROBES_PER_DIRECTORY = 2;

/**
 * Claude Desktop's MSIX package family: package name `Claude` and the
 * publisher ID Windows derives from `CN="Anthropic, PBC", O="Anthropic, PBC",
 * L=San Francisco, S=California, C=US, …`.
 */
const CLAUDE_DESKTOP_PACKAGE_FAMILY = "Claude_pzs8sxrjxfjjc";
const STORE_PACKAGE_FAMILY = "AnthropicPBC.Claude_fnn82j28hfe8t";

/** Observed Claude package names plus Windows' 13-character publisher ID. */
const CLAUDE_PACKAGE_FAMILY =
  /^(?:AnthropicPBC\.)?Claude_[0-9a-hjkmnp-tv-z]{13}$/iu;

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
  /** Installation evidence even when the deployment's configuration is unresolved. */
  readonly markerPath?: string;
  readonly msixPackage?: MsixPackageView;
}

/** Synchronous probes; each throws for failures other than absence. */
export interface ClaudeDesktopLocationFileSystem {
  /** A directory's names; with `limit`, at most that many, in enumeration order. */
  readonly readdir: (path: string, limit?: number) => readonly string[];
  readonly lstat: (path: string) => {
    isFile(): boolean;
    isDirectory(): boolean;
  };
  readonly realpath: (path: string) => string;
}

/** Up to `limit` names from a directory, without enumerating the rest. */
const readNames = (path: string, limit: number): string[] => {
  const directory = opendirSync(path);
  const names: string[] = [];
  try {
    while (names.length < limit) {
      const entry = directory.readSync();
      if (entry === null) break;
      names.push(entry.name);
    }
  } finally {
    directory.closeSync();
  }
  return names;
};

const systemFileSystem: ClaudeDesktopLocationFileSystem = {
  readdir: (path, limit) =>
    limit === undefined ? readdirSync(path) : readNames(path, limit),
  lstat: (path) => lstatSync(path),
  realpath: (path) => realpathSync.native(path),
};

/**
 * Resolve the `claude_desktop_config.json` that Windows Claude Desktop reads.
 * Without its MSIX package storage, that is the AppData file. With it, the
 * legacy package reads its private copy when one exists and the AppData file
 * otherwise. The Store package can move its standard profile out of AppData.
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
  const family = families[0];
  if (families.length > 1)
    return err({
      path: packagesDirectory,
      message: `Found multiple Claude Desktop package families under ${packagesDirectory}: ${families.join(", ")}. Open Settings > Developer > Edit Config in the intended app to identify its configuration.`,
    });
  if (family !== undefined) {
    const container = join(packagesDirectory, family);
    if (family.toLowerCase() === STORE_PACKAGE_FAMILY.toLowerCase())
      return resolveStoreLocation(
        fileSystem,
        roots,
        family,
        container,
        env.CLAUDE_USER_DATA_DIR,
      );
    if (family.toLowerCase() !== CLAUDE_DESKTOP_PACKAGE_FAMILY.toLowerCase())
      return err({
        path: container,
        message: `MSIX package storage ${container} has an unrecognized Claude Desktop package identity. REA cannot establish which ${CONFIG_FILE} that package reads and does not fall back to ${appDataConfigPath}. Open Settings > Developer > Edit Config in Claude Desktop to locate its configuration.`,
      });
  }
  const migratedDirectory = join(
    roots.local,
    "Claude-Data",
    CLAUDE_DESKTOP_PACKAGE_FAMILY.toLowerCase(),
  );
  const migrated = present(fileSystem, migratedDirectory);
  const migratedConfigPath = join(migratedDirectory, CONFIG_FILE);
  const migrationFailure = !migrated.ok
    ? migrated.error
    : migrated.value
      ? {
          path: migratedConfigPath,
          message: `Found migrated Claude Desktop storage at ${migratedDirectory}. REA cannot verify which configuration the installed app reads. Quit Claude Desktop fully, verify whether it reads ${migratedConfigPath}, then register REA manually in the active file.`,
        }
      : undefined;
  if (family === undefined) {
    if (migrationFailure !== undefined) return err(migrationFailure);
    const storeProfile = join(
      roots.local,
      "Claude-Data",
      STORE_PACKAGE_FAMILY.toLowerCase(),
    );
    const remaining = present(fileSystem, storeProfile);
    if (!remaining.ok) return remaining;
    if (remaining.value)
      return err({
        path: storeProfile,
        message: `Found Microsoft Store Claude Desktop profile data at ${storeProfile} without its package directory. Open Settings > Developer > Edit Config in the installed app to confirm its configuration.`,
      });
    return ok({ configPath: appDataConfigPath, markerPath: appDataDirectory });
  }
  const container = join(packagesDirectory, family);
  const privateRoaming = join(container, "LocalCache", "Roaming");
  const privateDirectory = join(privateRoaming, "Claude");
  const privateConfigPath = join(privateDirectory, CONFIG_FILE);
  const privateCopy = present(fileSystem, privateConfigPath);
  const packageView = (): MsixPackageView => ({
    packageFamilyName: family,
    storage: { kind: "roaming_overlay", privateConfigPath, appDataConfigPath },
    virtualizedRoots: [roots.roaming, roots.local],
    processView: processView(
      fileSystem,
      privateRoaming,
      roots.roaming,
      privateCopy.ok && privateCopy.value,
    ),
  });
  // The current process view matters even when the active Claude config is unknown.
  if (migrationFailure !== undefined)
    return err({ ...migrationFailure, msixPackage: packageView() });
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
    msixPackage: packageView(),
  });
};

/** The Store app can use a migrated standard profile or a separate 3P deployment. */
const resolveStoreLocation = (
  fileSystem: ClaudeDesktopLocationFileSystem,
  roots: ReturnType<typeof windowsAppDataRoots>,
  family: string,
  container: string,
  userDataOverride: string | undefined,
): Result<ClaudeDesktopLocation, ClaudeDesktopLocationFailure> => {
  const installed = inspectPath(fileSystem, container);
  if (!installed.ok) return installed;
  if (!installed.value?.isDirectory())
    return err({
      path: container,
      message: `Expected a Microsoft Store Claude Desktop package directory at ${container}. Check the installation and rerun.`,
    });
  const privateRoaming = join(container, "LocalCache", "Roaming");
  const privateClaude = join(privateRoaming, "Claude");
  const roamingClaude = join(roots.roaming, "Claude");
  const profile = join(roots.local, "Claude-Data", family.toLowerCase());
  const left = `.user-data-left.${family.toLowerCase()}`;
  const back = `.user-data-back.${family.toLowerCase()}`;
  const unresolved = (path: string, reason: string) =>
    err({
      path,
      message: `Microsoft Store Claude Desktop (${family}): ${reason}. Launch Claude Desktop and use Settings > Developer > Edit Config to confirm the active configuration. Quit the app fully before registering REA in that file.`,
    });
  const checkConfigPath = (): Result<string, ClaudeDesktopLocationFailure> => {
    if (userDataOverride)
      return unresolved(
        userDataOverride,
        "CLAUDE_USER_DATA_DIR selects a custom profile",
      );
    // Both modes can keep settings in Claude-3p. An empty folder is also
    // present on standard installations. A populated one needs mode selection.
    for (const root of [
      roots.local,
      roots.roaming,
      join(container, "LocalCache", "Local"),
      privateRoaming,
    ]) {
      const path = join(root, "Claude-3p");
      const contents = inspectOptional(path, () => fileSystem.readdir(path, 1));
      if (!contents.ok) return contents;
      if (contents.value?.length)
        return unresolved(
          path,
          `found 3P profile data at ${path} and cannot determine the active deployment`,
        );
    }
    const target = inspectPath(fileSystem, profile);
    if (!target.ok) return target;
    if (!target.value?.isDirectory())
      return unresolved(
        profile,
        `the standard profile at ${profile} has not been established`,
      );
    // The app uses the old profile after rollback. A remaining device identity
    // also requires the app's migration reconciliation before choosing a side.
    let handedOff = false;
    for (const directory of [privateClaude, roamingClaude]) {
      for (const name of [back, "ant-did"]) {
        const path = join(directory, name);
        const entry = inspectPath(fileSystem, path);
        if (!entry.ok) return entry;
        if (entry.value !== undefined)
          return unresolved(
            path,
            `found legacy profile evidence at ${path} alongside ${profile}`,
          );
      }
      const marker = inspectPath(fileSystem, join(directory, left));
      if (!marker.ok) return marker;
      if (marker.value?.isFile()) handedOff = true;
    }
    if (!handedOff) {
      // A fresh Store profile can have no previous data to move. When the
      // old location still has content, only the app can finish the handoff.
      const identity = inspectPath(fileSystem, join(profile, "ant-did"));
      if (!identity.ok) return identity;
      if (!identity.value?.isFile())
        return unresolved(
          profile,
          `the app has not initialized its standard profile at ${profile}`,
        );
      for (const directory of [privateClaude, roamingClaude]) {
        const entries = inspectOptional(directory, () =>
          fileSystem.readdir(directory, 1),
        );
        if (!entries.ok) return entries;
        if (entries.value?.length)
          return unresolved(
            directory,
            `found an earlier profile at ${directory} without a completed move to ${profile}`,
          );
      }
    }
    return ok(join(profile, CONFIG_FILE));
  };
  const config = checkConfigPath();
  const msixPackage: MsixPackageView = {
    packageFamilyName: family,
    storage: { kind: "store_profile", checkConfigPath },
    virtualizedRoots: [roots.roaming, roots.local],
    processView: processView(fileSystem, privateRoaming, roots.roaming, false),
  };
  return config.ok
    ? ok({ configPath: config.value, markerPath: container, msixPackage })
    : err({ ...config.error, markerPath: container, msixPackage });
};

/**
 * A process the package started sees the package's private files at their
 * AppData paths; any other process sees the real AppData files or nothing.
 * The package redirects the whole roaming root: its manifest excludes
 * directories only under LocalAppData (version 2.42304.0.0, checked on
 * 2026-10-18), so a private file from any roaming folder shows which view
 * this is. Claude Desktop's own folder is compared first. Some hosts never
 * get one, because the running app writes the real `%APPDATA%\Claude`; there
 * the files the package or its processes wrote in other roaming folders
 * decide. `LocalCache\Local` is not compared: files under its excluded
 * directories are not redirected, so they could not tell the views apart.
 */
const processView = (
  fileSystem: ClaudeDesktopLocationFileSystem,
  privateRoaming: string,
  appDataRoaming: string,
  privateConfig: boolean,
): MsixPackageView["processView"] => {
  const entryBudget = { inspected: 0 };
  const ownProbes = privateConfig
    ? [join("Claude", CONFIG_FILE)]
    : claudeFolderProbes(fileSystem, privateRoaming, entryBudget);
  const probes =
    ownProbes.length > 0
      ? ownProbes
      : roamingProbes(fileSystem, privateRoaming, entryBudget);
  let view: MsixPackageView["processView"] = "unknown";
  for (const probe of probes) {
    let privateTarget: string;
    try {
      privateTarget = fileSystem.realpath(join(privateRoaming, probe));
    } catch (cause: unknown) {
      // A private file that vanished cannot be compared; try another.
      void cause;
      continue;
    }
    const appDataPath = join(appDataRoaming, probe);
    const first = resolveAppData(fileSystem, appDataPath);
    if (first === undefined) return "unknown";
    if (first === privateTarget) return "redirected";
    // A private file deleted or replaced meanwhile no longer shadows its AppData
    // path, so a redirected view would also miss it or reach an ordinary copy
    // there. Count the probe only while the file is in place and a second
    // lookup agrees; a probe that changed between lookups decides nothing.
    if (!isPrivateFile(fileSystem, privateRoaming, probe)) continue;
    const second = resolveAppData(fileSystem, appDataPath);
    if (second === undefined) return "unknown";
    if (second === privateTarget) return "redirected";
    if (second === first) view = "direct";
  }
  return view;
};

/** Where an AppData path resolves: its target, `null` when it is missing, or `undefined` when it cannot be read. */
const resolveAppData = (
  fileSystem: ClaudeDesktopLocationFileSystem,
  path: string,
): string | null | undefined => {
  try {
    return fileSystem.realpath(path);
  } catch (cause: unknown) {
    return isMissing(cause) ? null : undefined;
  }
};

/** Private files in Claude Desktop's own roaming folder, as paths under the roaming root. */
const claudeFolderProbes = (
  fileSystem: ClaudeDesktopLocationFileSystem,
  privateRoaming: string,
  entryBudget: { inspected: number },
): readonly string[] => {
  try {
    const remaining = ROAMING_ENTRY_LIMIT - entryBudget.inspected;
    if (remaining <= 0) return [];
    const names = fileSystem.readdir(join(privateRoaming, "Claude"), remaining);
    // The filesystem has already materialized these names. Debit all returned
    // entries before selecting a handful of candidates so the budget covers
    // enumeration and sorting work as well as lstat calls.
    entryBudget.inspected += names.length;
    const probes: string[] = [];
    for (const name of names) {
      if (isPrivateFile(fileSystem, privateRoaming, join("Claude", name))) {
        probes.push(join("Claude", name));
        if (probes.length === PROCESS_VIEW_PROBES) break;
      }
    }
    return probes;
  } catch (cause: unknown) {
    // The folder may not exist; the rest of the roaming root can still decide.
    void cause;
    return [];
  }
};

/**
 * Private files anywhere under the roaming root, breadth first and within the
 * walk's bounds. Directories that cannot be listed are skipped, links are not
 * followed, and an entry is inspected only while the directory still needs a
 * file or the queue has room for a folder. A listing reads no more names than
 * the budget has left, so a crowded folder is never enumerated whole. A walk
 * that runs out of budget keeps the files it found; with none, the view stays
 * unknown.
 */
const roamingProbes = (
  fileSystem: ClaudeDesktopLocationFileSystem,
  privateRoaming: string,
  entryBudget: { inspected: number },
): readonly string[] => {
  const probes: string[] = [];
  const queue: { readonly path: string; readonly depth: number }[] = [
    { path: "", depth: 0 },
  ];
  for (
    let listed = 0;
    listed < ROAMING_DIRECTORY_LIMIT &&
    probes.length < PROCESS_VIEW_PROBES &&
    entryBudget.inspected < ROAMING_ENTRY_LIMIT;
    listed++
  ) {
    const directory = queue.shift();
    if (directory === undefined) break;
    let names: readonly string[];
    try {
      const enumerated = fileSystem.readdir(
        join(privateRoaming, directory.path),
        ROAMING_ENTRY_LIMIT - entryBudget.inspected,
      );
      // `readdir` and sorting have already processed every returned name, even
      // when queue/file limits mean only a prefix can be inspected below.
      entryBudget.inspected += enumerated.length;
      names = [...enumerated].sort();
    } catch (cause: unknown) {
      // An unreadable folder cannot be compared; the others still can.
      void cause;
      continue;
    }
    let taken = 0;
    for (const name of names) {
      const wantsFile = taken < PROBES_PER_DIRECTORY;
      const wantsFolder =
        directory.depth < ROAMING_DEPTH_LIMIT &&
        listed + queue.length < ROAMING_DIRECTORY_LIMIT - 1;
      if (!wantsFile && !wantsFolder) break;
      const path = join(directory.path, name);
      const entry = entryKind(fileSystem, join(privateRoaming, path));
      if (entry === "file" && wantsFile) {
        probes.push(path);
        taken += 1;
        if (probes.length === PROCESS_VIEW_PROBES) break;
      } else if (entry === "directory" && wantsFolder)
        queue.push({ path, depth: directory.depth + 1 });
    }
  }
  return probes;
};

const isPrivateFile = (
  fileSystem: ClaudeDesktopLocationFileSystem,
  privateRoaming: string,
  path: string,
): boolean => entryKind(fileSystem, join(privateRoaming, path)) === "file";

/** A listed entry's kind, without following links; one that vanished or is unreadable is neither. */
const entryKind = (
  fileSystem: ClaudeDesktopLocationFileSystem,
  path: string,
): "file" | "directory" | undefined => {
  try {
    const entry = fileSystem.lstat(path);
    return entry.isFile()
      ? "file"
      : entry.isDirectory()
        ? "directory"
        : undefined;
  } catch (cause: unknown) {
    // A candidate may vanish or become unreadable while listed.
    void cause;
    return undefined;
  }
};

const inspectOptional = <T>(
  path: string,
  inspect: () => T,
): Result<T | undefined, ClaudeDesktopLocationFailure> => {
  try {
    return ok(inspect());
  } catch (cause: unknown) {
    if (isMissing(cause)) return ok(undefined);
    return err({
      path,
      message: `${path} could not be inspected, so REA cannot establish which ${CONFIG_FILE} Claude Desktop's MSIX package reads: ${errorMessage(cause)}. Repair access to that path, then rerun.`,
    });
  }
};

const inspectPath = (
  fileSystem: ClaudeDesktopLocationFileSystem,
  path: string,
) => inspectOptional(path, () => fileSystem.lstat(path));

const present = (
  fileSystem: ClaudeDesktopLocationFileSystem,
  path: string,
): Result<boolean, ClaudeDesktopLocationFailure> => {
  const entry = inspectPath(fileSystem, path);
  return entry.ok ? ok(entry.value !== undefined) : entry;
};

const isMissing = (cause: unknown): boolean =>
  cause instanceof Error &&
  "code" in cause &&
  (cause.code === "ENOENT" || cause.code === "ENOTDIR");
