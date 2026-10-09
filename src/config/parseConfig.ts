import { accessSync, constants } from "node:fs";
import { join } from "node:path";

import { ConfigurationError } from "../domain/configurationErrors.js";
import { ok, type Result } from "../domain/result.js";
import { parseEnvironment } from "./environment.js";
import { homeDirectoryFromEnvironment } from "./homeDirectory.js";
import { parseStringArray, parseLoaderArgs } from "./parsers.js";
import type { AppConfig } from "./types.js";

const DEFAULT_HOPPER_LAUNCHER_PATH =
  "/Applications/Hopper Disassembler.app/Contents/MacOS/hopper";
const SYSTEM_LINUX_HOPPER = "/opt/hopper/bin/Hopper";

const executableAvailable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const defaultHopperLauncherPath = (
  platform: NodeJS.Platform,
  homeDirectory: string,
  executable: (path: string) => boolean = executableAvailable,
): string => {
  if (platform !== "linux") return DEFAULT_HOPPER_LAUNCHER_PATH;
  if (executable(SYSTEM_LINUX_HOPPER)) return SYSTEM_LINUX_HOPPER;
  const userLocal = join(homeDirectory, ".local/share/rea/hopper/bin/Hopper");
  return executable(userLocal) ? userLocal : SYSTEM_LINUX_HOPPER;
};

/** Parse provider configuration and runtime prerequisites at the composition root. */
export const parseConfig = (
  environment: Readonly<Record<string, string | undefined>>,
): Result<AppConfig, ConfigurationError> => {
  const parsed = parseEnvironment(environment);
  if (!parsed.ok) return parsed;
  const env = parsed.value;
  const loaderArgs = parseLoaderArgs(env.HOPPER_LOADER_ARGS_JSON);
  if (!loaderArgs.ok) return loaderArgs;
  const secretPatterns = parseStringArray(
    env.REA_REFERENCE_SECRET_PATTERNS_JSON,
    "REA_REFERENCE_SECRET_PATTERNS_JSON",
  );
  if (!secretPatterns.ok) return secretPatterns;
  return ok({
    ...(env.REA_MCP_MAX_RESPONSE_BYTES === undefined
      ? {}
      : { mcpMaxResponseBytes: env.REA_MCP_MAX_RESPONSE_BYTES }),
    analysisProvider: env.REA_ANALYSIS_PROVIDER,
    ...(env.REA_IDA_MCP_CONFIG === undefined
      ? {}
      : { idaMcpConfigPath: env.REA_IDA_MCP_CONFIG }),
    ghidraInstallDir: env.GHIDRA_INSTALL_DIR,
    ghidraJavaHome: env.JAVA_HOME,
    ghidraStartupTimeoutMs: env.REA_GHIDRA_STARTUP_TIMEOUT_MS,
    ...(env.REA_GHIDRA_NATIVEAOT_JAR === undefined
      ? {}
      : { ghidraNativeAotJar: env.REA_GHIDRA_NATIVEAOT_JAR }),
    ilspyCmdPath: env.REA_ILSPY_CMD_PATH,
    hopperLauncherPath:
      env.HOPPER_LAUNCHER_PATH ??
      defaultHopperLauncherPath(
        process.platform,
        homeDirectoryFromEnvironment(environment, process.platform),
      ),
    hopperTargetPath: env.HOPPER_TARGET_PATH,
    hopperTargetKind: env.HOPPER_TARGET_KIND,
    hopperLoaderArgs: loaderArgs.value,
    logLevel: env.REA_LOG_LEVEL,
    referenceSourcePolicy: { secretPatterns: secretPatterns.value },
  });
};
