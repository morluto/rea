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

/** Whether Hopper's `PythonPath` user default is set, and whether it exists. */
export type MacHopperPythonPath =
  | { readonly state: "unset" }
  | { readonly state: "set"; readonly path: string; readonly exists: boolean }
  | { readonly state: "unknown"; readonly reason: string };

/** Observed facts that decide whether Hopper can run REA's Python bootstrap. */
export interface MacHopperPythonFacts {
  readonly bundleIdentifier: string | undefined;
  readonly pythonPath: MacHopperPythonPath;
  readonly searchedRoots: readonly string[];
  /** Framework libraries present at the searched roots, in search-list order. */
  readonly frameworks: readonly string[];
}

/** Read-only host access for {@link readMacHopperPythonFacts}. */
export interface MacHopperPythonHost {
  readonly run: typeof execFileOutput;
  readonly env: NodeJS.ProcessEnv;
  /** Whether the path names an existing regular file. */
  readonly isFile: (path: string) => Promise<boolean>;
  /** Directory entry names, or an empty list when the directory is absent. */
  readonly listDirectory: (path: string) => Promise<readonly string[]>;
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
  const marker = ".app/Contents/MacOS/";
  const index = launcherPath.lastIndexOf(marker);
  return index < 0 ? undefined : launcherPath.slice(0, index + ".app".length);
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
  bundleIdentifier: string | undefined,
): Promise<MacHopperPythonPath> => {
  if (bundleIdentifier === undefined)
    return {
      state: "unknown",
      reason: "The Hopper launcher is not inside an application bundle.",
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
    return { state: "set", path, exists: await host.isFile(path) };
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
  const [pythonPath, frameworks] = await Promise.all([
    readPythonPath(host, bundleIdentifier),
    Promise.all(
      roots.map(async ({ root, library }) => {
        const versionsDirectory = posix.join(root, "Versions");
        const versions = (await host.listDirectory(versionsDirectory))
          .filter((version) => version !== "Current")
          .sort();
        const libraries = versions.map((version) =>
          posix.join(versionsDirectory, version, library),
        );
        const present = await Promise.all(libraries.map(host.isFile));
        return libraries.filter((_, index) => present[index]);
      }),
    ),
  ]);
  return {
    bundleIdentifier,
    pythonPath,
    searchedRoots: roots.map(({ root }) => root),
    frameworks: frameworks.flat(),
  };
};

const setPythonPathRemediation = (bundleIdentifier: string | undefined) =>
  `Quit Hopper, then point its PythonPath default at an installed framework library, for example: defaults write ${bundleIdentifier ?? "<Hopper bundle identifier>"} PythonPath /Library/Frameworks/Python.framework/Versions/<version>/Python (python.org installer) or the Homebrew python@3.12 Frameworks/Python.framework/Versions/3.12/Python. Then rerun rea doctor --provider hopper.`;

/** Decide the `hopper-python` doctor check from observed facts. */
export const macHopperPythonCheck = (
  facts: MacHopperPythonFacts,
): DoctorCheck => {
  const { pythonPath, frameworks, bundleIdentifier } = facts;
  const details = {
    scope: "hopper_python_default_and_framework_roots",
    hopper_interpreter:
      pythonPath.state === "set" && pythonPath.exists
        ? pythonPath.path
        : "unknown",
    bundle_identifier: bundleIdentifier ?? null,
    python_path:
      pythonPath.state === "set"
        ? { state: "set", path: pythonPath.path, exists: pythonPath.exists }
        : pythonPath.state === "unknown"
          ? { state: "unknown", reason: pythonPath.reason }
          : { state: "unset" },
    searched_roots: [...facts.searchedRoots],
    frameworks: [...frameworks],
  };
  if (pythonPath.state === "set")
    return pythonPath.exists
      ? {
          name: "hopper-python",
          ok: true,
          classification: "healthy",
          detail: `PythonPath=${pythonPath.path}`,
          details,
        }
      : {
          name: "hopper-python",
          ok: false,
          classification: "config_drift",
          detail: `PythonPath names a missing file: ${pythonPath.path}`,
          details,
          remediation: `Hopper cannot load this Python, so REA's bridge bootstrap will not run ("Cannot execute Python script"). ${setPythonPathRemediation(bundleIdentifier)} To let Hopper choose a framework instead, run: defaults delete ${bundleIdentifier ?? "<Hopper bundle identifier>"} PythonPath.`,
        };
  if (frameworks.length > 0)
    return {
      name: "hopper-python",
      ok: true,
      classification: "healthy",
      detail: `PythonPath ${pythonPath.state}; framework candidates: ${frameworks.join(", ")}`,
      details,
    };
  return {
    name: "hopper-python",
    ok: false,
    classification: "unknown",
    detail: `PythonPath ${pythonPath.state}; no Python framework found under ${facts.searchedRoots.join(", ")}`,
    details,
    remediation: `Hopper embeds no Python and may then fail to run REA's bridge bootstrap ("Cannot execute Python script" or "Python is Unavailable"). Hopper's own search beyond these roots is not observed. ${setPythonPathRemediation(bundleIdentifier)}`,
  };
};
