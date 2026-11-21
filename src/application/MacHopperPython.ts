import { posix } from "node:path";
import type { DoctorCheck } from "../ports/DoctorProviderInspection.js";
import {
  execFileOutputFailure,
  type execFileOutput,
} from "../process/ExecFileOutput.js";

/**
 * Hopper on macOS embeds no Python. It runs REA's bridge bootstrap with the
 * framework named by its `PythonPath` user default, or with a framework it
 * finds itself. Without one, Hopper logs "Cannot execute Python script" and
 * REA only observes a startup timeout (#7954).
 *
 * These are the framework roots observed or reported for Hopper 6.6.2. They do
 * not establish Hopper's full search order, so the interpreter Hopper will load
 * stays unknown unless `PythonPath` names it.
 */
const frameworkRoots = (developerDirectory: string | undefined) => [
  {
    root: "/Library/Frameworks/Python.framework",
    library: "Python",
  },
  {
    root: "/usr/local/Frameworks/Python.framework",
    library: "Python",
  },
  ...(developerDirectory === undefined
    ? []
    : [
        {
          root: posix.join(
            developerDirectory,
            "Library/Frameworks/Python3.framework",
          ),
          library: "Python3",
        },
      ]),
];

/** A regular file was observed, confirmed absent, or could not be checked. */
export type MacHopperFileState =
  | { readonly state: "file" }
  | { readonly state: "missing" }
  | { readonly state: "unknown"; readonly reason: string };

/** A directory was listed, confirmed absent, or could not be read. */
export type MacHopperDirectoryListing =
  | { readonly state: "listed"; readonly entries: readonly string[] }
  | { readonly state: "missing" }
  | { readonly state: "unknown"; readonly reason: string };

/** Whether Hopper's `PythonPath` user default is set, and what it names. */
export type MacHopperPythonPath =
  | { readonly state: "unset" }
  | {
      readonly state: "set";
      readonly path: string;
      readonly file: MacHopperFileState;
    }
  | { readonly state: "unknown"; readonly reason: string };

/** A framework path that could not be checked, with the reason. */
export interface MacHopperUnreadablePath {
  readonly path: string;
  readonly reason: string;
}

/** Observed facts that decide whether Hopper can run REA's Python bootstrap. */
export interface MacHopperPythonFacts {
  readonly bundleIdentifier: string | undefined;
  readonly pythonPath: MacHopperPythonPath;
  readonly searchedRoots: readonly string[];
  /** Framework libraries present at the searched roots, in search-list order. */
  readonly frameworks: readonly string[];
  /** Framework roots or libraries whose presence could not be checked. */
  readonly unreadable: readonly MacHopperUnreadablePath[];
}

/** Read-only host access for {@link readMacHopperPythonFacts}. */
export interface MacHopperPythonHost {
  readonly run: typeof execFileOutput;
  readonly env: NodeJS.ProcessEnv;
  readonly fileState: (path: string) => Promise<MacHopperFileState>;
  readonly listDirectory: (path: string) => Promise<MacHopperDirectoryListing>;
}

/**
 * The only settings `defaults` and `xcode-select` read here: HOME selects the
 * user's preferences and DEVELOPER_DIR the active developer directory. Unrelated
 * caller settings are not inherited, so a malformed one cannot stop the probe.
 */
export const macHopperPythonCommandEnvironment = (
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv => {
  const selected: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
  for (const name of ["HOME", "DEVELOPER_DIR"] as const) {
    const value = environment[name];
    if (value !== undefined && value !== "" && !value.includes("\0"))
      selected[name] = value;
  }
  return selected;
};

/** `<bundle>.app` that contains a `Contents/MacOS` launcher, if any. */
const appBundleOf = (launcherPath: string): string | undefined => {
  const index = launcherPath.lastIndexOf("/Contents/MacOS/");
  if (index < 0) return undefined;
  const bundle = launcherPath.slice(0, index);
  // Hopper discovery accepts renamed bundles case-insensitively (`Hopper*.APP`).
  return bundle.toLowerCase().endsWith(".app") ? bundle : undefined;
};

const readBundleIdentifier = async (
  host: MacHopperPythonHost,
  launcherPath: string,
): Promise<string | undefined> => {
  const bundle = appBundleOf(launcherPath);
  if (bundle === undefined) return undefined;
  try {
    const identifier = (
      await host.run(
        "/usr/bin/defaults",
        ["read", posix.join(bundle, "Contents/Info"), "CFBundleIdentifier"],
        { env: host.env },
      )
    ).stdout.trim();
    return identifier === "" ? undefined : identifier;
  } catch (cause: unknown) {
    if (execFileOutputFailure(cause) === undefined) throw cause;
    return undefined;
  }
};

const readPythonPath = async (
  host: MacHopperPythonHost,
  launcherPath: string,
  bundleIdentifier: string | undefined,
): Promise<MacHopperPythonPath> => {
  if (bundleIdentifier === undefined)
    return {
      state: "unknown",
      reason:
        appBundleOf(launcherPath) === undefined
          ? "The Hopper launcher is not inside an application bundle, so its preferences domain is unknown."
          : "The Hopper bundle identifier could not be read from its Info.plist.",
    };
  try {
    const path = (
      await host.run(
        "/usr/bin/defaults",
        ["read", bundleIdentifier, "PythonPath"],
        { env: host.env },
      )
    ).stdout.trim();
    if (path === "") return { state: "unset" };
    return { state: "set", path, file: await host.fileState(path) };
  } catch (cause: unknown) {
    const failure = execFileOutputFailure(cause);
    if (failure === undefined) throw cause;
    // `defaults read` exits 1 and names the missing pair when it is unset.
    if (failure.code === 1 && /does not exist/u.test(failure.stderr))
      return { state: "unset" };
    return {
      state: "unknown",
      reason: `defaults read ${bundleIdentifier} PythonPath failed: ${failure.stderr.trim() || String(failure.code)}`,
    };
  }
};

const readDeveloperDirectory = async (
  host: MacHopperPythonHost,
): Promise<string | undefined> => {
  try {
    const directory = (
      await host.run("/usr/bin/xcode-select", ["-p"], { env: host.env })
    ).stdout.trim();
    return directory === "" ? undefined : directory;
  } catch (cause: unknown) {
    if (execFileOutputFailure(cause) === undefined) throw cause;
    return undefined;
  }
};

/** Framework libraries under one root, and the paths that could not be checked. */
const readFrameworkRoot = async (
  host: MacHopperPythonHost,
  { root, library }: { readonly root: string; readonly library: string },
): Promise<{
  readonly frameworks: readonly string[];
  readonly unreadable: readonly MacHopperUnreadablePath[];
}> => {
  const versionsDirectory = posix.join(root, "Versions");
  const listing = await host.listDirectory(versionsDirectory);
  if (listing.state === "missing") return { frameworks: [], unreadable: [] };
  if (listing.state === "unknown")
    return {
      frameworks: [],
      unreadable: [{ path: versionsDirectory, reason: listing.reason }],
    };
  const libraries = listing.entries
    .filter((version) => version !== "Current")
    .sort()
    .map((version) => posix.join(versionsDirectory, version, library));
  const states = await Promise.all(libraries.map(host.fileState));
  return {
    frameworks: libraries.filter((_, index) => states[index]?.state === "file"),
    unreadable: libraries.flatMap((path, index) => {
      const state = states[index];
      return state?.state === "unknown" ? [{ path, reason: state.reason }] : [];
    }),
  };
};

/** Observe Hopper's Python configuration without launching Hopper. */
export const readMacHopperPythonFacts = async (
  host: MacHopperPythonHost,
  launcherPath: string,
): Promise<MacHopperPythonFacts> => {
  const [bundleIdentifier, developerDirectory] = await Promise.all([
    readBundleIdentifier(host, launcherPath),
    readDeveloperDirectory(host),
  ]);
  const roots = frameworkRoots(developerDirectory);
  const [pythonPath, rootResults] = await Promise.all([
    readPythonPath(host, launcherPath, bundleIdentifier),
    Promise.all(roots.map((root) => readFrameworkRoot(host, root))),
  ]);
  return {
    bundleIdentifier,
    pythonPath,
    searchedRoots: roots.map(({ root }) => root),
    frameworks: rootResults.flatMap(({ frameworks }) => frameworks),
    unreadable: rootResults.flatMap(({ unreadable }) => unreadable),
  };
};

const bundleLabel = (bundleIdentifier: string | undefined) =>
  bundleIdentifier ?? "<Hopper bundle identifier>";

const setPythonPathRemediation = (bundleIdentifier: string | undefined) =>
  `Quit Hopper, then point its PythonPath default at an installed framework library, for example: defaults write ${bundleLabel(bundleIdentifier)} PythonPath /Library/Frameworks/Python.framework/Versions/<version>/Python (python.org installer) or the Homebrew python@3.12 Frameworks/Python.framework/Versions/3.12/Python. Then rerun rea doctor --provider hopper.`;

const pythonPathDetails = (pythonPath: MacHopperPythonPath) =>
  pythonPath.state === "set"
    ? {
        state: "set",
        path: pythonPath.path,
        file: pythonPath.file.state,
        ...(pythonPath.file.state === "unknown"
          ? { reason: pythonPath.file.reason }
          : {}),
      }
    : pythonPath.state === "unknown"
      ? { state: "unknown", reason: pythonPath.reason }
      : { state: "unset" };

/** Decide the `hopper-python` doctor check from observed facts. */
export const macHopperPythonCheck = (
  facts: MacHopperPythonFacts,
): DoctorCheck => {
  const { pythonPath, frameworks, unreadable, bundleIdentifier } = facts;
  const details = {
    scope: "hopper_python_default_and_framework_roots",
    hopper_interpreter:
      pythonPath.state === "set" && pythonPath.file.state === "file"
        ? pythonPath.path
        : "unknown",
    bundle_identifier: bundleIdentifier ?? null,
    python_path: pythonPathDetails(pythonPath),
    searched_roots: [...facts.searchedRoots],
    frameworks: [...frameworks],
    unreadable: unreadable.map(({ path, reason }) => ({ path, reason })),
  };
  const check = (
    result: Omit<DoctorCheck, "name" | "details">,
  ): DoctorCheck => ({ name: "hopper-python", ...result, details });

  // An unread PythonPath could hide a broken override, so frameworks found
  // elsewhere cannot settle readiness.
  if (pythonPath.state === "unknown")
    return check({
      ok: false,
      classification: "unknown",
      detail: `Hopper's PythonPath default could not be read: ${pythonPath.reason}`,
      remediation: `Resolve the reported reason, or select Hopper's application launcher with HOPPER_LAUNCHER_PATH, then rerun rea doctor --provider hopper. ${setPythonPathRemediation(bundleIdentifier)}`,
    });
  if (pythonPath.state === "set")
    switch (pythonPath.file.state) {
      case "file":
        return check({
          ok: true,
          classification: "healthy",
          detail: `PythonPath=${pythonPath.path}`,
        });
      case "missing":
        return check({
          ok: false,
          classification: "config_drift",
          detail: `PythonPath does not name an existing file: ${pythonPath.path}`,
          remediation: `Hopper loads no Python from this setting and does not fall back, so REA's bridge bootstrap will not run ("Cannot execute Python script"). ${setPythonPathRemediation(bundleIdentifier)} To let Hopper choose a framework instead, run: defaults delete ${bundleLabel(bundleIdentifier)} PythonPath.`,
        });
      case "unknown":
        return check({
          ok: false,
          classification: "unknown",
          detail: `PythonPath ${pythonPath.path} could not be checked: ${pythonPath.file.reason}`,
          remediation: `Check that this account can read ${pythonPath.path}, then rerun rea doctor --provider hopper.`,
        });
    }
  if (frameworks.length > 0)
    return check({
      ok: true,
      classification: "healthy",
      detail: `PythonPath unset; framework candidates: ${frameworks.join(", ")}`,
    });
  const unchecked =
    unreadable.length === 0
      ? ""
      : `; could not check ${unreadable.map(({ path }) => path).join(", ")}`;
  return check({
    ok: false,
    classification: "unknown",
    detail: `PythonPath unset; no Python framework found under ${facts.searchedRoots.join(", ")}${unchecked}`,
    remediation: `Hopper embeds no Python and may then fail to run REA's bridge bootstrap ("Cannot execute Python script" or "Python is Unavailable"). Hopper's own search beyond these roots is not observed. ${setPythonPathRemediation(bundleIdentifier)}`,
  });
};
