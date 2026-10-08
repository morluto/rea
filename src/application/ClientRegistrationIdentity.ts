import { basename, isAbsolute, resolve } from "node:path";
import { valid } from "semver";

import { PRODUCT_IDENTITY } from "../identity.js";

const SHELL_WRAPPER = /^cmd(?:\.exe)?$/iu;
const SHELL_COMMAND_FLAG = /^\/c$/iu;

/**
 * Wrap one invocation so shell-less Windows clients can spawn it: `npx` is a
 * batch shim that requires cmd.exe to execute.
 */
export const windowsShellInvocation = (
  command: readonly string[],
): readonly string[] => ["cmd", "/c", ...command];

/** Strip one `cmd /c` shell wrapper from a registration command. */
export const unwrapShellInvocation = (
  command: readonly string[],
): readonly string[] =>
  command.length > 2 &&
  SHELL_WRAPPER.test(command[0] ?? "") &&
  SHELL_COMMAND_FLAG.test(command[1] ?? "")
    ? command.slice(2)
    : command;

/** Check that one parsed command points to REA's MCP entry point. */
export const isOwnedClientRegistrationCommand = (
  command: readonly string[],
  currentCommandPath: string = resolve(process.argv[1] ?? "unknown"),
): boolean => {
  command = unwrapShellInvocation(command);
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

  if (
    command.length !== 4 ||
    command[0] !== "npx" ||
    command[1] !== "-y" ||
    command[3] !== "mcp"
  )
    return false;

  const packageReference = command[2] ?? "";
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
