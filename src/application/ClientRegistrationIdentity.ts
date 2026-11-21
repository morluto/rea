import { HOST_PLATFORM } from "../platform/HostPlatform.js";
import {
  accessSync,
  constants,
  lstatSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, posix } from "node:path";
import {
  CURRENT_ENTRYPOINT_PATH,
  normalizeEntrypointPath,
} from "../process/CurrentEntrypointPath.js";
import { valid } from "semver";

import {
  javaScriptRuntime,
  type JavaScriptRuntime,
} from "../domain/runtimeVersion.js";
import { posixPathCandidates } from "../process/executableSearch.js";
import {
  absoluteCallerPath,
  appendCallerPath,
} from "../filesystem/callerPath.js";
import { PRODUCT_IDENTITY } from "../identity.js";
import {
  aubeShimLauncher,
  aubeShimRegistration,
  aubeShimTarget,
  type AubeShimLauncher,
  registeredAubeShim,
} from "../process/AubeBinShim.js";
import {
  msixPackagesDirectory,
  packagePrivateLauncherBlocker,
} from "./MsixPackageStorage.js";

/** Package runners recognized for invocation guidance and legacy registrations. */
type PackageRunner = "npx" | "bunx";

/** Read one variable; Windows variable names are case-insensitive. */
const environmentValue = (
  environment: Readonly<NodeJS.ProcessEnv>,
  name: string,
  platform: NodeJS.Platform,
): string | undefined => {
  if (platform !== "win32") return environment[name];
  const target = name.toLowerCase();
  const key = Object.keys(environment).findLast(
    (candidate) => candidate.toLowerCase() === target,
  );
  return key === undefined ? undefined : environment[key];
};

/** Identify the package runner that launched this process, if any. */
export const invokingPackageRunner = (
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform,
): PackageRunner | undefined => {
  if (environmentValue(environment, "npm_command", platform) !== "exec")
    return undefined;
  // `bunx` and `bun x` also report npm_command=exec, with a bun user agent.
  return environmentValue(
    environment,
    "npm_config_user_agent",
    platform,
  )?.startsWith("bun/") === true
    ? "bunx"
    : "npx";
};

/** Copy an environment without the variable that marks a package-runner launch. */
export const withoutPackageRunnerIdentity = (
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(environment).filter(([key]) =>
      platform === "win32"
        ? key.toLowerCase() !== "npm_command"
        : key !== "npm_command",
    ),
  );

/** A supported managed shim owns both the script and interpreter. */
export const managedClientLauncher = (
  entrypoint: string | undefined,
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform,
): AubeShimLauncher | undefined => {
  if (
    platform === "win32" ||
    entrypoint === undefined ||
    javaScriptRuntime(process.versions).id !== "node"
  )
    return undefined;
  const roots = transientLauncherRoots(environment);
  if (
    usesTransientLauncherPath(entrypoint, roots) ||
    usesTransientLauncherPath(process.execPath, roots)
  )
    return undefined;
  const launcher = aubeShimLauncher(
    entrypoint,
    PRODUCT_IDENTITY.cliBinary,
    process.execPath,
  );
  return launcher === undefined ||
    usesTransientLauncherPath(launcher.shim, roots)
    ? undefined
    : launcher;
};

/** Restrictions on the automatically selected launcher shared by setup and mcp add. */
export const defaultClientRegistrationBlocker = (
  command: readonly string[],
  platform: NodeJS.Platform,
  home: string,
  environment: Readonly<NodeJS.ProcessEnv>,
): string | undefined => {
  if (command.length === 0)
    return "REA could not determine persistent paths for the current runtime and REA entrypoint. Run the installed REA CLI from outside the session directory, then retry.";
  if (platform === "win32")
    return packagePrivateLauncherBlocker(
      command,
      msixPackagesDirectory(home, environment),
    );
  return undefined;
};

/** Bind the selected REA entrypoint to the runtime already executing setup. */
export const currentClientRegistrationCommand = (
  selection: {
    readonly platform?: NodeJS.Platform;
    readonly entrypointPath?: string | undefined;
    readonly environment?: Readonly<NodeJS.ProcessEnv>;
  } = {},
): readonly string[] => {
  // The registration names this process's runtime, so it defaults to this host.
  const platform = selection.platform ?? HOST_PLATFORM.platform;
  const environment = selection.environment ?? process.env;
  const entrypointPath = Object.hasOwn(selection, "entrypointPath")
    ? selection.entrypointPath
    : CURRENT_ENTRYPOINT_PATH;
  if (entrypointPath === undefined || entrypointPath.length === 0) return [];
  const managed = managedClientLauncher(entrypointPath, environment, platform);
  if (managed !== undefined) return aubeShimRegistration(managed);
  const runtime = registrationRuntimePath(
    process.execPath,
    javaScriptRuntime(process.versions).id,
    environment,
    platform,
  );
  const script = registrationEntrypointPath(
    entrypointPath,
    environment,
    platform,
  );
  return runtime === undefined || script === undefined
    ? []
    : [runtime, script, "mcp"];
};

const unwrapCmdCommand = (command: readonly string[]): readonly string[] => {
  const executable = command[0]?.toLowerCase();
  if (executable !== "cmd" && executable !== "cmd.exe") return command;
  if (command[1]?.toLowerCase() === "/c") return command.slice(2);
  if (command[1]?.toLowerCase() === "/d" && command[2]?.toLowerCase() === "/c")
    return command.slice(3);
  return [];
};

/** Preserve the package argument from a supported package-runner command. */
const clientRegistrationPackageReference = (
  command: readonly string[],
): string | undefined => {
  const arguments_ = unwrapCmdCommand(command);
  if (
    arguments_.length === 4 &&
    arguments_[0] === "npx" &&
    arguments_[1] === "-y" &&
    arguments_[3] === "mcp"
  )
    return arguments_[2];
  if (
    arguments_.length === 3 &&
    arguments_[0] === "bunx" &&
    arguments_[2] === "mcp"
  )
    return arguments_[1];
  return undefined;
};

/** Check that one parsed command points to REA's MCP entry point. */
export type ClientRegistrationCommandIdentity = "owned" | "foreign" | "unknown";

/** Compare entrypoint paths without turning failed resolution into a foreign identity. */
const entrypointIdentity = (
  candidate: string,
  current: string,
): ClientRegistrationCommandIdentity => {
  if (!isAbsolute(candidate) || !isAbsolute(current)) return "unknown";
  if (candidate === current) return "owned";
  // Bun's realpath can normalize parent segments differently from its launcher.
  // Without matching traversal semantics it cannot prove ownership of an alias.
  // The comparison resolves paths on this host's filesystem.
  if (
    HOST_PLATFORM.platform !== "win32" &&
    javaScriptRuntime(process.versions).id === "bun" &&
    [candidate, current].some((path) => path.split("/").includes(".."))
  )
    return "unknown";
  try {
    return realpathSync.native(candidate) === realpathSync.native(current)
      ? "owned"
      : "foreign";
  } catch {
    return "unknown";
  }
};

/** A direct launcher may be a native executable or a Node shebang script. */
const directEntrypointIdentity = (
  candidate: string,
  current: string,
): ClientRegistrationCommandIdentity => {
  const nativeIdentity = entrypointIdentity(candidate, current);
  const scriptPath = normalizeEntrypointPath(candidate, "node");
  if (scriptPath === candidate) return nativeIdentity;
  // A shebang can pass the original spelling to Node, which selects its script
  // lexically. Without executing the launcher, divergent interpretations are unknown.
  return scriptPath !== undefined &&
    entrypointIdentity(scriptPath, current) === nativeIdentity
    ? nativeIdentity
    : "unknown";
};

/** Preserve a manager-owned executable alias only when it selects the same file. */
const sameFileExecutableAlias = (
  selected: string,
  name: string,
  environment: Readonly<NodeJS.ProcessEnv>,
  identify: typeof entrypointIdentity,
): string | undefined => {
  const roots = transientLauncherRoots(environment);
  let fallback = selected;
  if (usesTransientLauncherPath(selected, roots)) {
    try {
      fallback = realpathSync.native(selected);
      if (
        transientLauncherPath(fallback, roots) ||
        identify(fallback, selected) !== "owned"
      )
        return undefined;
    } catch {
      return undefined;
    }
  }
  for (const { path: candidate } of posixPathCandidates(
    name,
    environment.PATH ?? "",
    { relativeEntries: "skip" },
  )) {
    if (identify(candidate, selected) !== "owned") continue;
    if (usesTransientLauncherPath(candidate, roots)) continue;
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // An unexecutable alias cannot launch the selected program.
    }
  }
  return fallback;
};

/** Follow directory and file links in POSIX lookup order, before realpath can erase a session hop. */
const usesTransientLauncherPath = (
  path: string,
  roots: readonly string[],
): boolean => {
  if (!posix.isAbsolute(path)) return false;
  const activeLinks = new Set<string>();
  const transient = Symbol("transient");
  const walk = (
    target: string,
    directory: string,
  ): string | typeof transient | undefined => {
    const absolute = posix.isAbsolute(target);
    const spelled = absolute
      ? target
      : appendCallerPath(directory, target, "linux");
    if (transientLauncherPath(spelled, roots)) return transient;
    let current = absolute ? "/" : directory;
    for (const component of target.split("/")) {
      if (component === "" || component === ".") continue;
      if (component === "..") {
        current = posix.dirname(current);
        continue;
      }
      const next = posix.join(current, component);
      if (transientLauncherPath(next, roots)) return transient;
      if (!lstatSync(next).isSymbolicLink()) {
        current = next;
        continue;
      }
      if (activeLinks.has(next)) return undefined;
      activeLinks.add(next);
      const destination = walk(readlinkSync(next), current);
      activeLinks.delete(next);
      if (typeof destination !== "string") return destination;
      current = destination;
    }
    return current;
  };
  try {
    return walk(path, "/") === transient;
  } catch {
    // A missing or unreadable component is not evidence of a session hop.
    // Ownership and launch readiness are checked independently.
    return false;
  }
};

const transientLauncherRoots = (
  environment: Readonly<NodeJS.ProcessEnv>,
): readonly string[] => {
  const { FNM_MULTISHELL_PATH, XDG_RUNTIME_DIR } = environment;
  const roots = [FNM_MULTISHELL_PATH, XDG_RUNTIME_DIR];
  if (XDG_RUNTIME_DIR !== undefined && posix.isAbsolute(XDG_RUNTIME_DIR)) {
    try {
      roots.push(realpathSync.native(XDG_RUNTIME_DIR));
    } catch {
      // Its spelling is still useful when the runtime directory is already gone.
    }
  }
  // fnm's session directory is itself a link to the installed version.
  return roots.flatMap((root) => {
    if (root === undefined || !posix.isAbsolute(root)) return [];
    const directory = absoluteCallerPath(root, { platform: "linux" }).replace(
      /\/$/u,
      "",
    );
    return directory === "" ? [] : [directory];
  });
};

/** A fnm session path can outlive its shell environment but still be transient. */
const transientLauncherPath = (
  path: string,
  roots: readonly string[],
): boolean => {
  const absolute = absoluteCallerPath(path, { platform: "linux" });
  if (/(?:^|\/)fnm_multishells\/\d+_\d+(?:\/|$)/u.test(absolute)) return true;
  return roots.some(
    (directory) =>
      absolute === directory || absolute.startsWith(`${directory}/`),
  );
};

export const transientClientLauncherPaths = (
  command: readonly string[],
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform,
): readonly string[] => {
  if (platform === "win32") return [];
  const shim = registeredAubeShim(command);
  const paths =
    shim !== undefined
      ? [shim.shim, shim.fallbackRuntime]
      : command.length === 3 && command[2] === "mcp"
        ? command.slice(0, 2)
        : [];
  if (paths.length === 0) return [];
  const roots = transientLauncherRoots(environment);
  return paths.filter((path) => usesTransientLauncherPath(path, roots));
};

/** Prefer an executable PATH alias that proves the same selected REA file. */
const registrationEntrypointPath = (
  entrypoint: string,
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform,
): string | undefined =>
  // A Windows command shim is a different program; file identity cannot prove
  // its script target. Keep that platform's existing Node/script registration.
  platform === "win32"
    ? entrypoint
    : sameFileExecutableAlias(
        entrypoint,
        PRODUCT_IDENTITY.cliBinary,
        environment,
        directEntrypointIdentity,
      );

/** Prefer a same-file runtime alias that can survive its manager's version switch. */
export const registrationRuntimePath = (
  executable: string,
  runtime: JavaScriptRuntime["id"],
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform,
): string | undefined =>
  platform === "win32"
    ? executable
    : sameFileExecutableAlias(
        executable,
        runtime,
        environment,
        entrypointIdentity,
      );

/** Preserve aliases only when the execution form and selected file agree. */
export const equivalentClientRegistrationCommands = (
  previous: readonly string[],
  requested: readonly string[],
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform,
): boolean => {
  if (transientClientLauncherPaths(previous, environment, platform).length > 0)
    return false;
  if (
    previous.length === requested.length &&
    previous.every((value, index) => value === requested[index])
  )
    return true;
  const requestedFacts = inspectClientRegistrationCommand(requested, undefined);
  const current = requestedFacts.entrypoint;
  if (current === undefined) return false;
  const prior = inspectClientRegistrationCommand(previous, current);
  return (
    prior.entrypoint !== undefined &&
    prior.identity === "owned" &&
    prior.launch === requestedFacts.launch &&
    (prior.launch !== "managed_shim" ||
      prior.fallbackRuntimeIdentity === "owned")
  );
};

export interface ClientRegistrationCommandFacts {
  readonly identity: ClientRegistrationCommandIdentity;
  /** Execution form is separate from ownership of the selected REA file. */
  readonly launch:
    | "runtime_script"
    | "managed_shim"
    | "direct"
    | "package_runner"
    | "unknown";
  /** Selected absolute launcher/script path; excludes package and unresolved PATH commands. */
  readonly entrypoint: string | undefined;
  /** A managed shim's fallback can drift while its primary interpreter still runs. */
  readonly fallbackRuntimeIdentity?: ClientRegistrationCommandIdentity;
  readonly package:
    | {
        readonly reference: string;
        readonly exactVersion: string | undefined;
      }
    | undefined;
}

/** Parse package identity once, retaining exact source spelling and version facts. */
export const inspectClientRegistrationCommand = (
  command: readonly string[],
  currentCommandPath: string | undefined,
): ClientRegistrationCommandFacts => {
  const reference = clientRegistrationPackageReference(command);
  if (reference !== undefined) {
    const prefix = `${PRODUCT_IDENTITY.packageName}@`;
    const version = reference.startsWith(prefix)
      ? reference.slice(prefix.length)
      : undefined;
    const normalized = version === undefined ? null : valid(version);
    const owned =
      reference === PRODUCT_IDENTITY.packageName ||
      reference === PRODUCT_IDENTITY.packageSpecifier ||
      reference === PRODUCT_IDENTITY.registrationPackageSpecifier ||
      normalized !== null;
    return {
      identity: owned ? "owned" : "foreign",
      launch: "package_runner",
      entrypoint: undefined,
      package: {
        reference,
        exactVersion: normalized === version ? version : undefined,
      },
    };
  }
  return inspectDirectRegistrationCommand(command, currentCommandPath);
};

/** Ownership-only consumers share the same parsed command facts. */
export const classifyClientRegistrationCommand = (
  command: readonly string[],
  currentCommandPath: string | undefined,
): ClientRegistrationCommandIdentity =>
  inspectClientRegistrationCommand(command, currentCommandPath).identity;

const inspectDirectRegistrationCommand = (
  command: readonly string[],
  currentCommandPath: string | undefined,
): ClientRegistrationCommandFacts => {
  const currentPathAvailable =
    currentCommandPath !== undefined && currentCommandPath.length > 0;
  const managed = registeredAubeShim(command);
  if (managed !== undefined) {
    const target =
      HOST_PLATFORM.platform === "win32"
        ? undefined
        : aubeShimTarget(
            managed.shim,
            process.execPath,
            managed.fallbackRuntime,
          );
    return {
      launch: "managed_shim",
      identity:
        target === undefined || !currentPathAvailable
          ? "unknown"
          : entrypointIdentity(target, currentCommandPath),
      entrypoint: target,
      fallbackRuntimeIdentity: entrypointIdentity(
        managed.fallbackRuntime,
        process.execPath,
      ),
      package: undefined,
    };
  }
  if (command.length === 3 && command[2] === "mcp") {
    const interpreter = command[0] ?? "";
    const entrypoint = command[1] ?? "";
    if (!isAbsolute(interpreter) || !isAbsolute(entrypoint))
      return {
        identity: "unknown",
        launch: "runtime_script",
        entrypoint: undefined,
        package: undefined,
      };
    const interpreterIdentity = entrypointIdentity(
      interpreter,
      process.execPath,
    );
    if (interpreterIdentity !== "owned")
      return {
        identity: currentPathAvailable ? interpreterIdentity : "unknown",
        launch: "runtime_script",
        entrypoint: undefined,
        package: undefined,
      };
    // The proven current runtime owns script selection: Node normalizes argv,
    // while Bun follows native traversal through symlink/.. on POSIX.
    const selectedEntrypoint = normalizeEntrypointPath(entrypoint);
    return {
      launch: "runtime_script",
      identity:
        selectedEntrypoint === undefined || !currentPathAvailable
          ? "unknown"
          : entrypointIdentity(selectedEntrypoint, currentCommandPath),
      entrypoint: selectedEntrypoint,
      package: undefined,
    };
  }
  if (command.length === 2 && command[1] === "mcp") {
    const executable = command[0] ?? "";
    if (executable === PRODUCT_IDENTITY.cliBinary)
      return {
        identity: "owned",
        launch: "direct",
        entrypoint: undefined,
        package: undefined,
      };
    const managedTarget =
      HOST_PLATFORM.platform !== "win32" &&
      javaScriptRuntime(process.versions).id === "node"
        ? aubeShimTarget(executable, process.execPath)
        : undefined;
    if (managedTarget !== undefined)
      return {
        launch: "direct",
        identity: currentPathAvailable
          ? entrypointIdentity(managedTarget, currentCommandPath)
          : "unknown",
        entrypoint: managedTarget,
        package: undefined,
      };
    if (isAbsolute(executable))
      return {
        launch: "direct",
        identity: currentPathAvailable
          ? directEntrypointIdentity(executable, currentCommandPath)
          : "unknown",
        entrypoint: executable,
        package: undefined,
      };
    if (/[./\\]/u.test(executable))
      return {
        identity: "unknown",
        launch: "direct",
        entrypoint: undefined,
        package: undefined,
      };
  }
  return {
    identity: "foreign",
    launch: "unknown",
    entrypoint: undefined,
    package: undefined,
  };
};
