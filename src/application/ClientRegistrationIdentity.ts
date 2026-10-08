import { basename, isAbsolute, resolve } from "node:path";
import { valid } from "semver";

import { PRODUCT_IDENTITY } from "../identity.js";

/** Resolve a pinned npx launcher that stdio clients can spawn on the host. */
export const npxRegistrationCommand = (
  platform: NodeJS.Platform = process.platform,
): readonly string[] => {
  const command = [
    "npx",
    "-y",
    PRODUCT_IDENTITY.registrationPackageSpecifier,
    "mcp",
  ];
  return platform === "win32" ? ["cmd.exe", "/d", "/c", ...command] : command;
};

const unwrapNpxCommand = (command: readonly string[]): readonly string[] => {
  const executable = command[0]?.toLowerCase();
  if (executable !== "cmd" && executable !== "cmd.exe") return command;
  if (command[1]?.toLowerCase() === "/c") return command.slice(2);
  if (command[1]?.toLowerCase() === "/d" && command[2]?.toLowerCase() === "/c")
    return command.slice(3);
  return [];
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

  const npxCommand = unwrapNpxCommand(command);
  if (
    npxCommand.length !== 4 ||
    npxCommand[0] !== "npx" ||
    npxCommand[1] !== "-y" ||
    npxCommand[3] !== "mcp"
  )
    return false;

  const packageReference = npxCommand[2] ?? "";
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
