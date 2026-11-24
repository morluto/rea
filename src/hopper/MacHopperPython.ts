import { readdir, realpath } from "node:fs/promises";
import { posix } from "node:path";
import {
  readFatContainerTable,
  readMachoHeaderPrefixFacts,
} from "../domain/apple/machoContainer.js";
import {
  RegularFileCancelled,
  RegularFileCleanupFailure,
  withOwnedRegularFile,
} from "../filesystem/OwnedRegularFile.js";
import { readFileHandleRange } from "../filesystem/readFileHandleRange.js";
import {
  NonRegularFileReadError,
  RegularFileOperationCancelled,
} from "../filesystem/RegularFile.js";
import { errorMessage } from "../kernel/errorMessage.js";
import type { RetainedResourceScope } from "../ports/AnalysisProvider.js";
import type { DoctorCheck } from "../ports/DoctorProviderInspection.js";
import {
  execFileOutputFailure,
  type execFileOutput,
} from "../process/ExecFileOutput.js";

/**
 * Hopper on macOS embeds no Python. It runs REA's bridge bootstrap with the
 * library named by its `PythonPath` user default, or with a framework it finds
 * itself. Without one, Hopper logs "Cannot execute Python script" and REA only
 * observes a startup timeout (#7954).
 *
 * These are the framework roots observed or reported for Hopper 6.6.2. They do
 * not establish Hopper's full search order, so the interpreter it will load
 * stays unknown.
 */
const frameworkRoots = (developerDirectory: string | undefined) => [
  { root: "/Library/Frameworks/Python.framework", library: "Python" },
  { root: "/usr/local/Frameworks/Python.framework", library: "Python" },
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

const ARM64 = 0x0100000c;
const X86_64 = 0x01000007;
/** Magic, count and the largest fat table that the shared parser admits. */
const HEADER_BYTES = 8 + 128 * 32;

/**
 * What a candidate's header establishes. A compatible image is not proof that
 * Hopper loads Python from it: Hopper 6.6.2 accepted a Python executable and
 * refused a compatible library that is not Python.
 */
type MacHopperImage =
  | { readonly state: "compatible" }
  | { readonly state: "incompatible"; readonly reason: string }
  | { readonly state: "missing" }
  | { readonly state: "unknown"; readonly reason: string };

type ResolvedPath =
  | { readonly state: "resolved"; readonly path: string }
  | { readonly state: "unknown"; readonly reason: string };

type DirectoryListing =
  | { readonly state: "listed"; readonly entries: readonly string[] }
  | { readonly state: "missing" }
  | { readonly state: "unknown"; readonly reason: string };

/** Read-only host access for {@link inspectMacHopperPython}. */
export interface MacHopperPythonHost {
  readonly run: (
    command: string,
    arguments_: readonly string[],
  ) => Promise<{ readonly stdout: string }>;
  /** The filesystem identity of a selected launcher. */
  readonly resolvePath: (path: string) => Promise<ResolvedPath>;
  readonly image: (path: string) => Promise<MacHopperImage>;
  readonly listDirectory: (path: string) => Promise<DirectoryListing>;
}

type PythonPath =
  | { readonly state: "unset" }
  | {
      readonly state: "set";
      readonly path: string;
      readonly image: MacHopperImage;
    }
  | { readonly state: "unknown"; readonly reason: string };

interface FrameworkFacts {
  readonly frameworks: readonly string[];
  readonly rejected: readonly UnusablePath[];
  readonly unreadable: readonly UnusablePath[];
}

interface UnusablePath {
  readonly path: string;
  readonly reason: string;
}

/** Only these errors confirm that a probed path does not exist. */
const isAbsent = (cause: unknown): boolean => {
  const code = cause instanceof Error ? Reflect.get(cause, "code") : undefined;
  return code === "ENOENT" || code === "ENOTDIR";
};

/**
 * HOME selects the user's preferences and DEVELOPER_DIR the active developer
 * directory. Unrelated caller settings are not inherited, so a malformed one
 * cannot stop the probe.
 */
const commandEnvironment = (
  environment: Readonly<NodeJS.ProcessEnv>,
): NodeJS.ProcessEnv => {
  const selected: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
  for (const name of ["HOME", "DEVELOPER_DIR"] as const) {
    const value = environment[name];
    if (value !== undefined && value !== "" && !value.includes("\0"))
      selected[name] = value;
  }
  return selected;
};

/**
 * An x64 REA may run under Rosetta beside a native Hopper, so it accepts either
 * architecture. An arm64 REA establishes an arm64 host.
 */
const acceptedCpuTypes = (
  architecture: NodeJS.Architecture,
): readonly number[] => (architecture === "arm64" ? [ARM64] : [ARM64, X86_64]);

const classifyImage = (
  header: Uint8Array,
  architecture: NodeJS.Architecture,
): MacHopperImage => {
  const fat = readFatContainerTable(header);
  const thin = readMachoHeaderPrefixFacts(header).identity;
  const cpuTypes =
    fat.state === "parsed"
      ? fat.slices.map(({ cpuType }) => cpuType)
      : thin === null
        ? []
        : [thin.cpuType];
  if (cpuTypes.length === 0)
    return { state: "incompatible", reason: "not a Mach-O image" };
  const accepted = acceptedCpuTypes(architecture);
  return cpuTypes.some((cpuType) => accepted.includes(cpuType))
    ? { state: "compatible" }
    : {
        state: "incompatible",
        reason: `no Mach-O slice for this host (${architecture})`,
      };
};

/** Compose the read-only host that doctor uses on macOS. */
export const createMacHopperPythonHost = (options: {
  readonly run: typeof execFileOutput;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly architecture: NodeJS.Architecture;
  readonly resourceScope: RetainedResourceScope;
  readonly signal?: AbortSignal;
}): MacHopperPythonHost => {
  const env = commandEnvironment(options.environment);
  return {
    run: (command, arguments_) => options.run(command, arguments_, { env }),
    resolvePath: async (path) => {
      try {
        return { state: "resolved", path: await realpath(path) };
      } catch (cause: unknown) {
        return { state: "unknown", reason: errorMessage(cause) };
      }
    },
    image: async (path) => {
      try {
        return await withOwnedRegularFile(
          path,
          {
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            retainFailedClose: (owner) =>
              options.resourceScope.retain(owner, path),
          },
          async ({ handle }) =>
            classifyImage(
              await readFileHandleRange(handle, 0, HEADER_BYTES),
              options.architecture,
            ),
        );
      } catch (cause: unknown) {
        if (
          cause instanceof RegularFileCleanupFailure ||
          cause instanceof RegularFileCancelled ||
          cause instanceof RegularFileOperationCancelled
        )
          throw cause;
        if (isAbsent(cause)) return { state: "missing" };
        return cause instanceof NonRegularFileReadError
          ? { state: "incompatible", reason: "not a regular file" }
          : { state: "unknown", reason: errorMessage(cause) };
      }
    },
    listDirectory: async (path) => {
      try {
        return { state: "listed", entries: await readdir(path) };
      } catch (cause: unknown) {
        return isAbsent(cause)
          ? { state: "missing" }
          : { state: "unknown", reason: errorMessage(cause) };
      }
    },
  };
};

/** Command output, or undefined when the command itself reported a failure. */
const commandOutput = async (
  host: MacHopperPythonHost,
  command: string,
  arguments_: readonly string[],
): Promise<string | undefined> => {
  try {
    const output = (await host.run(command, arguments_)).stdout.trim();
    return output === "" ? undefined : output;
  } catch (cause: unknown) {
    if (execFileOutputFailure(cause) === undefined) throw cause;
    return undefined;
  }
};

/** `<bundle>.app` that contains a `Contents/MacOS` launcher, if any. */
const appBundleOf = (launcherPath: string): string | undefined => {
  const index = launcherPath.lastIndexOf("/Contents/MacOS/");
  if (index < 0) return undefined;
  const bundle = launcherPath.slice(0, index);
  // Hopper discovery accepts renamed bundles case-insensitively (`Hopper*.APP`).
  return bundle.toLowerCase().endsWith(".app") ? bundle : undefined;
};

type BundleIdentity =
  | { readonly state: "known"; readonly identifier: string }
  | { readonly state: "unknown"; readonly reason: string };

/** Runtime launches the file behind an alias, so identify that file's bundle. */
const readBundleIdentity = async (
  host: MacHopperPythonHost,
  launcherPath: string,
): Promise<BundleIdentity> => {
  const resolved = await host.resolvePath(launcherPath);
  if (resolved.state === "unknown")
    return {
      state: "unknown",
      reason: `The Hopper launcher could not be resolved: ${resolved.reason}`,
    };
  const bundle = appBundleOf(resolved.path);
  if (bundle === undefined)
    return {
      state: "unknown",
      reason:
        "The Hopper launcher is not inside an application bundle, so its preferences domain is unknown.",
    };
  const identifier = await commandOutput(host, "/usr/bin/defaults", [
    "read",
    posix.join(bundle, "Contents/Info"),
    "CFBundleIdentifier",
  ]);
  return identifier === undefined
    ? {
        state: "unknown",
        reason:
          "The Hopper bundle identifier could not be read from its Info.plist.",
      }
    : { state: "known", identifier };
};

const readPythonPath = async (
  host: MacHopperPythonHost,
  bundle: BundleIdentity,
): Promise<PythonPath> => {
  if (bundle.state === "unknown") return bundle;
  try {
    const path = (
      await host.run("/usr/bin/defaults", [
        "read",
        bundle.identifier,
        "PythonPath",
      ])
    ).stdout.trim();
    return path === ""
      ? { state: "unset" }
      : { state: "set", path, image: await host.image(path) };
  } catch (cause: unknown) {
    const failure = execFileOutputFailure(cause);
    if (failure === undefined) throw cause;
    // `defaults read` exits 1 and names the missing pair when it is unset.
    if (failure.code === 1 && /does not exist/u.test(failure.stderr))
      return { state: "unset" };
    return {
      state: "unknown",
      reason: `defaults read ${bundle.identifier} PythonPath failed: ${failure.stderr.trim() || String(failure.code)}`,
    };
  }
};

const readFrameworkRoot = async (
  host: MacHopperPythonHost,
  { root, library }: { readonly root: string; readonly library: string },
): Promise<FrameworkFacts> => {
  const versions = posix.join(root, "Versions");
  const listing = await host.listDirectory(versions);
  if (listing.state !== "listed")
    return {
      frameworks: [],
      rejected: [],
      unreadable:
        listing.state === "missing"
          ? []
          : [{ path: versions, reason: listing.reason }],
    };
  const images = await Promise.all(
    listing.entries
      .filter((version) => version !== "Current")
      .sort()
      .map(async (version) => {
        const path = posix.join(versions, version, library);
        return { path, image: await host.image(path) };
      }),
  );
  return {
    frameworks: images.flatMap(({ path, image }) =>
      image.state === "compatible" ? [path] : [],
    ),
    rejected: images.flatMap(({ path, image }) =>
      image.state === "incompatible" ? [{ path, reason: image.reason }] : [],
    ),
    unreadable: images.flatMap(({ path, image }) =>
      image.state === "unknown" ? [{ path, reason: image.reason }] : [],
    ),
  };
};

const pythonPathDetails = (pythonPath: PythonPath) =>
  pythonPath.state === "set"
    ? {
        state: "set",
        path: pythonPath.path,
        image: pythonPath.image.state,
        ...("reason" in pythonPath.image
          ? { reason: pythonPath.image.reason }
          : {}),
      }
    : { ...pythonPath };

/** Observe Hopper's Python configuration without launching Hopper. */
export const inspectMacHopperPython = async (
  host: MacHopperPythonHost,
  launcherPath: string,
): Promise<DoctorCheck> => {
  const [bundle, developerDirectory] = await Promise.all([
    readBundleIdentity(host, launcherPath),
    commandOutput(host, "/usr/bin/xcode-select", ["-p"]),
  ]);
  const roots = frameworkRoots(developerDirectory);
  const [pythonPath, rootFacts] = await Promise.all([
    readPythonPath(host, bundle),
    Promise.all(roots.map((root) => readFrameworkRoot(host, root))),
  ]);
  return projectCheck(bundle, pythonPath, {
    searchedRoots: roots.map(({ root }) => root),
    frameworks: rootFacts.flatMap(({ frameworks }) => frameworks),
    rejected: rootFacts.flatMap(({ rejected }) => rejected),
    unreadable: rootFacts.flatMap(({ unreadable }) => unreadable),
  });
};

/** Decide the `hopper-python` doctor check from observed facts. */
const projectCheck = (
  bundle: BundleIdentity,
  pythonPath: PythonPath,
  facts: FrameworkFacts & { readonly searchedRoots: readonly string[] },
): DoctorCheck => {
  const domain =
    bundle.state === "known" ? bundle.identifier : "<Hopper bundle identifier>";
  const setPythonPath = `Quit Hopper, then point its PythonPath default at an installed Python framework library, for example: defaults write ${domain} PythonPath /Library/Frameworks/Python.framework/Versions/<version>/Python. Then rerun rea doctor --provider hopper.`;
  const check = (
    result: Omit<DoctorCheck, "name" | "details">,
  ): DoctorCheck => ({
    name: "hopper-python",
    ...result,
    details: {
      scope: "hopper_python_default_and_framework_roots",
      hopper_interpreter: "unknown",
      bundle_identifier: bundle.state === "known" ? bundle.identifier : null,
      python_path: pythonPathDetails(pythonPath),
      searched_roots: [...facts.searchedRoots],
      frameworks: [...facts.frameworks],
      rejected: facts.rejected.map((entry) => ({ ...entry })),
      unreadable: facts.unreadable.map((entry) => ({ ...entry })),
    },
  });

  // An unread PythonPath could hide a broken override, so frameworks found
  // elsewhere cannot settle readiness.
  if (pythonPath.state === "unknown")
    return check({
      ok: false,
      classification: "unknown",
      detail: `Hopper's PythonPath default could not be read: ${pythonPath.reason}`,
      remediation: `Resolve the reported reason, or select Hopper's application launcher with HOPPER_LAUNCHER_PATH, then rerun rea doctor --provider hopper.`,
    });
  if (pythonPath.state === "set") {
    const { path, image } = pythonPath;
    switch (image.state) {
      case "compatible":
        // Header facts cannot establish that Hopper loads Python from the file.
        return check({
          ok: true,
          classification: "unknown",
          detail: `PythonPath=${path} is a compatible image; whether Hopper loads Python from it is not observed`,
        });
      case "missing":
      case "incompatible":
        return check({
          ok: false,
          classification: "config_drift",
          detail:
            image.state === "missing"
              ? `PythonPath does not name an existing file: ${path}`
              : `PythonPath does not name a loadable image: ${path} (${image.reason})`,
          remediation: `Hopper loads no Python from this setting and does not fall back, so REA's bridge bootstrap will not run ("Cannot execute Python script"). ${setPythonPath} To let Hopper choose a framework instead, run: defaults delete ${domain} PythonPath.`,
        });
      case "unknown":
        return check({
          ok: false,
          classification: "unknown",
          detail: `PythonPath ${path} could not be checked: ${image.reason}`,
          remediation: `Check that this account can read ${path}, then rerun rea doctor --provider hopper.`,
        });
    }
  }
  if (facts.frameworks.length > 0)
    return check({
      ok: true,
      classification: "unknown",
      detail: `PythonPath unset; compatible framework candidates: ${facts.frameworks.join(", ")}; which one Hopper loads is not observed`,
    });
  const unchecked =
    facts.unreadable.length === 0
      ? ""
      : `; could not check ${facts.unreadable.map(({ path }) => path).join(", ")}`;
  return check({
    ok: false,
    classification: "unknown",
    detail: `PythonPath unset; no compatible Python framework found under ${facts.searchedRoots.join(", ")}${unchecked}`,
    remediation: `Hopper embeds no Python and may then fail to run REA's bridge bootstrap ("Cannot execute Python script" or "Python is Unavailable"). Hopper's own search beyond these roots is not observed. ${setPythonPath}`,
  });
};
