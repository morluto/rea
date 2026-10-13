import { basename, isAbsolute, resolve } from "node:path";
import { valid } from "semver";

import { PRODUCT_IDENTITY } from "../identity.js";
import { packageRunnerCommand } from "../../scripts/lib/packageRunnerCommand.mjs";

/** Package runners whose pinned launcher setup can register. */
export type PackageRunner = "npx" | "bunx";

/** Read one variable; Windows variable names are case-insensitive. */
const environmentValue = (
  environment: Readonly<NodeJS.ProcessEnv>,
  name: string,
  platform: NodeJS.Platform,
): string | undefined => {
  if (platform !== "win32") return environment[name];
  const key = Object.keys(environment).find(
    (candidate) => candidate.toLowerCase() === name,
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

/** Resolve a pinned package-runner launcher that stdio clients can spawn on the host. */
export const packageRunnerRegistrationCommand = (
  runner: PackageRunner,
  platform: NodeJS.Platform = process.platform,
): readonly string[] =>
  packageRunnerCommand(
    runner,
    PRODUCT_IDENTITY.registrationPackageSpecifier,
    platform,
  );

/** Resolve a pinned npx launcher that stdio clients can spawn on the host. */
export const npxRegistrationCommand = (
  platform: NodeJS.Platform = process.platform,
): readonly string[] => packageRunnerRegistrationCommand("npx", platform);

const unwrapCmdCommand = (command: readonly string[]): readonly string[] => {
  const executable = command[0]?.toLowerCase();
  if (executable !== "cmd" && executable !== "cmd.exe") return command;
  if (command[1]?.toLowerCase() === "/c") return command.slice(2);
  if (command[1]?.toLowerCase() === "/d" && command[2]?.toLowerCase() === "/c")
    return command.slice(3);
  return [];
};

const packageRunnerReference = (
  command: readonly string[],
): string | undefined => {
  if (
    command.length === 4 &&
    command[0] === "npx" &&
    command[1] === "-y" &&
    command[3] === "mcp"
  )
    return command[2];
  if (command.length === 3 && command[0] === "bunx" && command[2] === "mcp")
    return command[1];
  return undefined;
};

const isOwnedPackageReference = (packageReference: string): boolean => {
  if (
    packageReference === PRODUCT_IDENTITY.packageName ||
    packageReference === PRODUCT_IDENTITY.packageSpecifier ||
    packageReference === PRODUCT_IDENTITY.registrationPackageSpecifier
  )
    return true;
  const versionPrefix = `${PRODUCT_IDENTITY.packageName}@`;
  return (
    packageReference.startsWith(versionPrefix) &&
    valid(packageReference.slice(versionPrefix.length)) !== null
  );
};

/** Check that one parsed command points to REA's MCP entry point. */
export const isOwnedClientRegistrationCommand = (
  command: readonly string[],
  currentCommandPath: string = resolve(process.argv[1] ?? "unknown"),
): boolean => {
  if (
    command.length === 3 &&
    command[2] === "mcp" &&
    resolve(command[0] ?? "") === resolve(process.execPath) &&
    resolve(command[1] ?? "") === currentCommandPath
  )
    return true;

  if (command.length === 2 && command[1] === "mcp") {
    const executable = command[0] ?? "";
    if (
      executable === PRODUCT_IDENTITY.cliBinary ||
      (isAbsolute(executable) &&
        basename(executable) === PRODUCT_IDENTITY.cliBinary) ||
      resolve(executable) === currentCommandPath
    )
      return true;
  }

  const packageReference = packageRunnerReference(unwrapCmdCommand(command));
  return (
    packageReference !== undefined && isOwnedPackageReference(packageReference)
  );
};
