import { lstat } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { err, ok, type Result } from "../domain/result.js";
import { errorMessage } from "../kernel/errorMessage.js";

/** The package's process view and the storage its client uses for registration. */
export interface MsixPackageView {
  readonly packageFamilyName: string;
  readonly storage:
    | {
        readonly kind: "roaming_overlay";
        /** The private copy shadows ordinary AppData as soon as it exists. */
        readonly privateConfigPath: string;
        readonly appDataConfigPath: string;
      }
    | {
        readonly kind: "store_profile";
        /** Resolve the active Store profile again before changing its configuration. */
        readonly checkConfigPath: () => Result<
          string,
          { readonly path: string; readonly message: string }
        >;
      };
  /** Roots whose writes the package redirects for processes it starts. */
  readonly virtualizedRoots: readonly string[];
  /**
   * `redirected`: this process sees one of the package's private files at its
   * AppData path, so the running package started it. `direct`: it does not.
   * `unknown`: no private file could be compared.
   */
  readonly processView: "redirected" | "direct" | "unknown";
}

/** Windows' roaming and local application data roots; empty means unset. */
export const windowsAppDataRoots = (
  home: string,
  env: Readonly<NodeJS.ProcessEnv>,
): { readonly roaming: string; readonly local: string } => ({
  roaming: env.APPDATA || join(home, "AppData", "Roaming"),
  local: env.LOCALAPPDATA || join(home, "AppData", "Local"),
});

/** The per-user root of MSIX package data containers. */
export const msixPackagesDirectory = (
  home: string,
  env: Readonly<NodeJS.ProcessEnv>,
): string => join(windowsAppDataRoots(home, env).local, "Packages");

/** Whether `path` is `root` or inside it, using the host's path comparison. */
const pathWithin = (path: string, root: string): boolean => {
  const inner = relative(root, path);
  return (
    inner === "" ||
    (inner !== ".." && !inner.startsWith(`..${sep}`) && !isAbsolute(inner))
  );
};

/**
 * Name the package whose private `LocalCache` holds a canonical path. Its
 * processes see those files at virtual AppData locations; other processes do
 * not, and Windows removes them with the package.
 */
const packagePrivateStorageFamily = (
  canonicalPath: string,
  packagesDirectory: string,
): string | undefined => {
  if (!pathWithin(canonicalPath, packagesDirectory)) return undefined;
  const [family, storage] = relative(packagesDirectory, canonicalPath).split(
    /[\\/]/u,
  );
  return family !== undefined &&
    family !== "" &&
    storage?.toLowerCase() === "localcache"
    ? family
    : undefined;
};

/**
 * Explain why automatic registration must skip a launcher that exists only in one
 * package's private storage. Other clients could not start it, and doctor
 * outside that package could not verify it.
 */
export const packagePrivateLauncherBlocker = (
  command: readonly string[],
  packagesDirectory: string,
  canonicalPath: (path: string) => string = realpathSync.native,
): string | undefined => {
  // Compare canonical forms: a short-name, junctioned or substituted profile
  // spells the same directory differently.
  let packages = packagesDirectory;
  try {
    packages = canonicalPath(packagesDirectory);
  } catch (cause: unknown) {
    // Without package storage, the spelled path is the only comparison.
    void cause;
  }
  for (const part of command) {
    if (!isAbsolute(part)) continue;
    let resolved: string;
    try {
      resolved = canonicalPath(part);
    } catch (cause: unknown) {
      // A launcher that cannot be resolved is not evidence of package storage.
      void cause;
      continue;
    }
    const family = packagePrivateStorageFamily(resolved, packages);
    if (family !== undefined)
      return `The REA launcher ${part} is stored at ${resolved}, inside the private storage of MSIX package ${family}. Only processes started by that app can see it at ${part}, and Windows removes it with the package, so other clients could not start this registration. Install REA from a terminal that the app did not start (for example with \`npm install -g rea-agents\`), then retry the registration from that terminal.`;
  }
  return undefined;
};

/**
 * Explain why this process must not write `targets`: the running package
 * started it, so writes under its virtualized roots land in that package's
 * private storage, which the targets' owners never read.
 */
const canonicalDestination = (
  path: string,
  canonicalPath: (path: string) => string,
): Result<string, { readonly path: string; readonly detail: string }> => {
  let ancestor = path;
  const missing: string[] = [];
  while (true) {
    try {
      return ok(join(canonicalPath(ancestor), ...missing));
    } catch (cause: unknown) {
      if (
        cause instanceof Error &&
        "code" in cause &&
        (cause.code === "ENOENT" || cause.code === "ENOTDIR") &&
        dirname(ancestor) !== ancestor
      ) {
        missing.unshift(basename(ancestor));
        ancestor = dirname(ancestor);
        continue;
      }
      return err({
        path,
        detail: errorMessage(cause),
      });
    }
  }
};

export const redirectedWriteBlocker = (
  view: MsixPackageView | undefined,
  targets: readonly string[],
  operation: "setup" | "uninstall" | "mcp add",
  canonicalPath: (path: string) => string = realpathSync.native,
): string | undefined => {
  if (view?.processView !== "redirected" || targets.length === 0)
    return undefined;
  const roots: string[] = [];
  const redirected: string[] = [];
  for (const root of view.virtualizedRoots) {
    const resolved = canonicalDestination(root, canonicalPath);
    if (!resolved.ok)
      return `Cannot establish the MSIX write location for ${resolved.error.path}: ${resolved.error.detail}. Rerun ${operation} from a terminal that this app did not start.`;
    roots.push(resolved.value);
  }
  for (const target of targets) {
    const resolved = canonicalDestination(target, canonicalPath);
    if (!resolved.ok)
      return `Cannot establish the MSIX write location for ${resolved.error.path}: ${resolved.error.detail}. Rerun ${operation} from a terminal that this app did not start.`;
    if (roots.some((root) => pathWithin(resolved.value, root)))
      redirected.push(target);
  }
  if (redirected.length === 0) return undefined;
  return `This process was started by MSIX package ${view.packageFamilyName}, which redirects its writes under ${view.virtualizedRoots.join(" and ")} into the package's private storage. Changes to ${redirected.join(", ")} would not reach the files other apps read. Rerun ${operation} from a terminal that this app did not start.`;
};

/** An unavailable read-target observation does not establish a target change. */
interface MsixReadTargetInspectionFailure {
  readonly _tag: "MsixReadTargetInspectionFailure";
  readonly path: string;
  readonly detail: string;
  readonly cause: unknown;
}

/** Whether the file the package reads changed after the plan selected it. */
export const packageReadTargetChanged = async (
  view: MsixPackageView,
  configPath: string,
): Promise<Result<boolean, MsixReadTargetInspectionFailure>> => {
  const { storage } = view;
  if (storage.kind === "store_profile") {
    const target = storage.checkConfigPath();
    if (target.ok) return ok(target.value !== configPath);
    return err({
      _tag: "MsixReadTargetInspectionFailure",
      path: target.error.path,
      detail: target.error.message,
      cause: target.error,
    });
  }
  if (configPath !== storage.appDataConfigPath) return ok(false);
  try {
    await lstat(storage.privateConfigPath);
    return ok(true);
  } catch (cause: unknown) {
    if (
      cause instanceof Error &&
      "code" in cause &&
      (cause.code === "ENOENT" || cause.code === "ENOTDIR")
    )
      return ok(false);
    return err({
      _tag: "MsixReadTargetInspectionFailure",
      path: storage.privateConfigPath,
      detail: `The package-private configuration at ${storage.privateConfigPath} could not be inspected. ${errorMessage(cause)}. Repair access to that path, then rerun setup.`,
      cause,
    });
  }
};
