import { execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute } from "node:path";
import { absoluteCallerPath } from "../filesystem/callerPath.js";

/** Locate an executable binary in PATH or common candidate directories. */
const findExecutableInPath = (
  binaryName: string,
  environment: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
  fallbackDirectories: readonly string[] = [],
): string | undefined => {
  const pathVariable =
    platform === "win32"
      ? environment.PATH ?? environment.Path ?? ""
      : environment.PATH ?? "";
  const directories = [
    ...pathVariable.split(delimiter),
    ...fallbackDirectories,
  ].filter((directory): directory is string => directory.length > 0);

  const candidateNames =
    platform === "win32"
      ? [`${binaryName}.exe`, `${binaryName}.cmd`, binaryName]
      : [binaryName];

  for (const directory of directories) {
    for (const name of candidateNames) {
      const fullPath = absoluteCallerPath(`${directory}/${name}`);
      try {
        accessSync(fullPath, constants.X_OK);
        return fullPath;
      } catch {
        // Continue searching.
      }
    }
  }
  return undefined;
};

/**
 * Resolve an absolute Python executable managed or discoverable via `uv`.
 * Returns undefined when `uv` or its Python is unavailable.
 */
export const resolveUvPythonPath = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined => {
  if (
    typeof environment.REA_PWNTOOLS_PYTHON === "string" &&
    isAbsolute(environment.REA_PWNTOOLS_PYTHON)
  ) {
    return environment.REA_PWNTOOLS_PYTHON;
  }

  const userProfile = environment.USERPROFILE ?? environment.HOME ?? "";
  const fallbacks =
    platform === "win32"
      ? [
          `${userProfile}\\.local\\bin`,
          `${environment.APPDATA ?? ""}\\uv`,
          `${userProfile}\\.cargo\\bin`,
        ]
      : [`${userProfile}/.local/bin`, `${userProfile}/.cargo/bin`];

  const uvBinary = findExecutableInPath("uv", environment, platform, fallbacks);
  if (uvBinary === undefined) return undefined;

  try {
    const output = execFileSync(uvBinary, ["python", "find"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
      env: environment as NodeJS.ProcessEnv,
    }).trim();
    if (output.length > 0 && isAbsolute(output)) {
      accessSync(output, constants.X_OK);
      return output;
    }
  } catch {
    // uv not working or no python installed under uv.
  }

  return undefined;
};
