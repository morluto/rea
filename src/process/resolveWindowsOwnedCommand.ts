import { createRequire } from "node:module";
import { win32 } from "node:path";

const require = createRequire(import.meta.url);

interface ParsedWindowsCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly file?: unknown;
  readonly options: { readonly windowsVerbatimArguments?: boolean };
}

const parseWindowsCommand = require("cross-spawn/lib/parse") as (
  command: string,
  args: readonly string[],
  options: { readonly env: NodeJS.ProcessEnv },
) => ParsedWindowsCommand;

export interface ResolvedWindowsOwnedCommand {
  readonly command: string;
  readonly arguments: readonly string[];
  readonly windowsVerbatimArguments: boolean;
}

/**
 * Resolve a PATH name to the absolute executable cross-spawn would launch.
 * The Windows job owner rejects a bare name with Win32 87.
 */
export const resolveWindowsOwnedCommand = (
  command: string,
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
): ResolvedWindowsOwnedCommand => {
  const parsed = parseWindowsCommand(command, arguments_, {
    env: environment,
  });
  if (
    typeof parsed.command !== "string" ||
    !Array.isArray(parsed.args) ||
    !parsed.args.every((argument) => typeof argument === "string")
  )
    throw new TypeError(
      "cross-spawn returned an unsupported Windows command shape",
    );
  const executable =
    parsed.command === command && typeof parsed.file === "string"
      ? parsed.file
      : parsed.command;
  if (!win32.isAbsolute(executable))
    throw new Error(
      `Windows owned process could not resolve an absolute executable for ${command}`,
    );
  return {
    command: executable,
    arguments: parsed.args,
    windowsVerbatimArguments: parsed.options.windowsVerbatimArguments === true,
  };
};
