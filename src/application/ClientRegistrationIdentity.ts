import { accessSync, constants } from "node:fs";
import { isAbsolute } from "node:path";
import {
  CURRENT_ENTRYPOINT_PATH,
  normalizeEntrypointPath,
} from "../process/CurrentEntrypointPath.js";
import { valid } from "semver";

import {
  javaScriptRuntime,
  type JavaScriptRuntime,
} from "../domain/runtimeVersion.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import {
  compareExistingFileIdentities,
  hasParentPathSegment,
  inspectFileIdentity,
} from "../filesystem/fileIdentity.js";
import { PRODUCT_IDENTITY } from "../identity.js";

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
  platform: NodeJS.Platform = process.platform,
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
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(environment).filter(([key]) =>
      platform === "win32"
        ? key.toLowerCase() !== "npm_command"
        : key !== "npm_command",
    ),
  );

/** Bind the selected REA entrypoint to the runtime already executing setup. */
export const currentClientRegistrationCommand = (
  selection: {
    readonly platform?: NodeJS.Platform;
    readonly entrypointPath?: string | undefined;
    readonly environment?: Readonly<NodeJS.ProcessEnv>;
  } = {},
): readonly string[] => {
  const platform = selection.platform ?? process.platform;
  const environment = selection.environment ?? process.env;
  const entrypointPath = Object.hasOwn(selection, "entrypointPath")
    ? selection.entrypointPath
    : CURRENT_ENTRYPOINT_PATH;
  if (entrypointPath === undefined || entrypointPath.length === 0) return [];
  return [
    registrationRuntimePath(
      process.execPath,
      javaScriptRuntime(process.versions).id,
      environment,
      platform,
    ),
    registrationEntrypointPath(entrypointPath, environment, platform),
    "mcp",
  ];
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
  const comparison = compareExistingFileIdentities(
    inspectFileIdentity(candidate),
    inspectFileIdentity(current),
  );
  if (comparison === "same") return "owned";
  if (comparison === "different") return "foreign";
  return "unknown";
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

/**
 * Require the same canonical launch location before reusing or preferring a PATH
 * alias. Hardlinks share an inode (so ownership is "owned") yet resolve relative
 * ESM imports under the alias directory instead of the package's scripts directory.
 */
const sameCanonicalLaunchLocation = (
  candidate: string,
  selected: string,
  checkNodeScriptPath: boolean,
): boolean => {
  if (candidate === selected) return true;
  if (
    process.platform !== "win32" &&
    javaScriptRuntime(process.versions).id === "bun" &&
    [candidate, selected].some(hasParentPathSegment)
  )
    return false;
  const candidateSnapshot = inspectFileIdentity(candidate);
  const selectedSnapshot = inspectFileIdentity(selected);
  if (
    candidateSnapshot.realpath === undefined ||
    selectedSnapshot.realpath === undefined ||
    candidateSnapshot.realpath !== selectedSnapshot.realpath
  )
    return false;
  if (!checkNodeScriptPath) return true;
  const scriptPath = normalizeEntrypointPath(candidate, "node");
  if (scriptPath === undefined) return false;
  if (scriptPath === candidate) return true;
  return inspectFileIdentity(scriptPath).realpath === selectedSnapshot.realpath;
};

/** Preserve a manager-owned executable alias only when it selects the same file. */
const sameFileExecutableAlias = (
  selected: string,
  name: string,
  environment: Readonly<NodeJS.ProcessEnv>,
  identify: typeof entrypointIdentity,
): string => {
  for (const directory of (environment.PATH ?? "").split(":")) {
    if (!isAbsolute(directory)) continue;
    const candidate = absoluteCallerPath(`${directory}/${name}`);
    if (identify(candidate, selected) !== "owned") continue;
    if (
      !sameCanonicalLaunchLocation(
        candidate,
        selected,
        identify === directEntrypointIdentity,
      )
    )
      continue;
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // An unexecutable alias cannot launch the selected program.
    }
  }
  return selected;
};

/** Prefer an executable PATH alias that proves the same selected REA file. */
const registrationEntrypointPath = (
  entrypoint: string,
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform,
): string =>
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
): string =>
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
): boolean => {
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
    prior.launchLocationCompatible &&
    (prior.launch !== "runtime_script" ||
      sameCanonicalLaunchLocation(previous[0] ?? "", requested[0] ?? "", false))
  );
};

export interface ClientRegistrationCommandFacts {
  readonly identity: ClientRegistrationCommandIdentity;
  /** Execution form is separate from ownership of the selected REA file. */
  readonly launch: "runtime_script" | "direct" | "package_runner" | "unknown";
  /**
   * Whether the registered runtime and entrypoint resolve at the same canonical
   * location as the running installation (e.g. symlinks pass, hardlinks fail
   * relative ESM imports under the alias directory).
   */
  readonly launchLocationCompatible: boolean;
  /** Selected absolute launcher/script path; excludes package and unresolved PATH commands. */
  readonly entrypoint: string | undefined;
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
      launchLocationCompatible: false,
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
  if (command.length === 3 && command[2] === "mcp") {
    const interpreter = command[0] ?? "";
    const entrypoint = command[1] ?? "";
    if (!isAbsolute(interpreter) || !isAbsolute(entrypoint))
      return {
        identity: "unknown",
        launch: "runtime_script",
        launchLocationCompatible: false,
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
        launchLocationCompatible: false,
        entrypoint: undefined,
        package: undefined,
      };
    // The proven current runtime owns script selection: Node normalizes argv,
    // while Bun follows native traversal through symlink/.. on POSIX.
    const selectedEntrypoint = normalizeEntrypointPath(entrypoint);
    const identity =
      selectedEntrypoint === undefined || !currentPathAvailable
        ? "unknown"
        : entrypointIdentity(selectedEntrypoint, currentCommandPath);
    return {
      launch: "runtime_script",
      identity,
      launchLocationCompatible:
        identity === "owned" &&
        selectedEntrypoint !== undefined &&
        currentPathAvailable &&
        sameCanonicalLaunchLocation(
          selectedEntrypoint,
          currentCommandPath,
          false,
        ) &&
        sameCanonicalLaunchLocation(interpreter, process.execPath, false),
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
        launchLocationCompatible: false,
        entrypoint: undefined,
        package: undefined,
      };
    if (isAbsolute(executable)) {
      const identity = currentPathAvailable
        ? directEntrypointIdentity(executable, currentCommandPath)
        : "unknown";
      return {
        launch: "direct",
        identity,
        launchLocationCompatible:
          identity === "owned" &&
          currentPathAvailable &&
          sameCanonicalLaunchLocation(executable, currentCommandPath, true),
        entrypoint: executable,
        package: undefined,
      };
    }
    if (/[./\\]/u.test(executable))
      return {
        identity: "unknown",
        launch: "direct",
        launchLocationCompatible: false,
        entrypoint: undefined,
        package: undefined,
      };
  }
  return {
    identity: "foreign",
    launch: "unknown",
    launchLocationCompatible: false,
    entrypoint: undefined,
    package: undefined,
  };
};
