import { ConfigurationError } from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";
import { parseEnvironment } from "./environment.js";
import { parseStringArray, parseLoaderArgs } from "./parsers.js";
import type { AppConfig } from "./types.js";

const defaultHopperLauncherPath = (): string =>
  process.platform === "linux"
    ? "/opt/hopper/bin/Hopper"
    : "/Applications/Hopper Disassembler.app/Contents/MacOS/hopper";

/** Parse provider configuration and runtime prerequisites at the composition root. */
export const parseConfig = (
  environment: Readonly<Record<string, string | undefined>>,
): Result<AppConfig, ConfigurationError> => {
  const parsed = parseEnvironment(environment);
  if (!parsed.ok) return parsed;
  const env = parsed.value;
  if (
    env.REA_BINARY_NINJA_MCP_URL !== undefined &&
    env.REA_BINARY_NINJA_MCP_COMMAND !== undefined
  )
    return err(
      new ConfigurationError(
        "Set either REA_BINARY_NINJA_MCP_URL or REA_BINARY_NINJA_MCP_COMMAND, not both",
      ),
    );
  if (
    env.REA_BINARY_NINJA_MCP_TOKEN !== undefined &&
    env.REA_BINARY_NINJA_MCP_URL === undefined
  )
    return err(
      new ConfigurationError(
        "REA_BINARY_NINJA_MCP_TOKEN requires REA_BINARY_NINJA_MCP_URL",
      ),
    );
  const binaryNinjaArgs = parseLoaderArgs(env.REA_BINARY_NINJA_MCP_ARGS_JSON);
  if (!binaryNinjaArgs.ok)
    return err(
      new ConfigurationError(
        "REA_BINARY_NINJA_MCP_ARGS_JSON must be a JSON array of strings",
      ),
    );
  if (
    binaryNinjaArgs.value.length > 0 &&
    env.REA_BINARY_NINJA_MCP_COMMAND === undefined
  )
    return err(
      new ConfigurationError(
        "REA_BINARY_NINJA_MCP_ARGS_JSON requires REA_BINARY_NINJA_MCP_COMMAND",
      ),
    );
  const loaderArgs = parseLoaderArgs(env.HOPPER_LOADER_ARGS_JSON);
  if (!loaderArgs.ok) return loaderArgs;
  const secretPatterns = parseStringArray(
    env.REA_REFERENCE_SECRET_PATTERNS_JSON,
    "REA_REFERENCE_SECRET_PATTERNS_JSON",
  );
  if (!secretPatterns.ok) return secretPatterns;
  return ok({
    ...(env.REA_BINARY_NINJA_MCP_URL === undefined &&
    env.REA_BINARY_NINJA_MCP_COMMAND === undefined
      ? {}
      : {
          binaryNinjaMcp: {
            ...(env.REA_BINARY_NINJA_MCP_URL === undefined
              ? {}
              : { url: env.REA_BINARY_NINJA_MCP_URL }),
            ...(env.REA_BINARY_NINJA_MCP_COMMAND === undefined
              ? {}
              : { command: env.REA_BINARY_NINJA_MCP_COMMAND }),
            ...(env.REA_BINARY_NINJA_MCP_TOKEN === undefined
              ? {}
              : { token: env.REA_BINARY_NINJA_MCP_TOKEN }),
            args: binaryNinjaArgs.value,
            timeoutMs: env.REA_BINARY_NINJA_MCP_TIMEOUT_MS,
          },
        }),
    analysisProvider: env.REA_ANALYSIS_PROVIDER,
    ...(env.REA_IDA_MCP_CONFIG === undefined
      ? {}
      : { idaMcpConfigPath: env.REA_IDA_MCP_CONFIG }),
    ghidraInstallDir: env.GHIDRA_INSTALL_DIR,
    ghidraJavaHome: env.JAVA_HOME,
    ...(env.REA_GHIDRA_NATIVEAOT_JAR === undefined
      ? {}
      : { ghidraNativeAotJar: env.REA_GHIDRA_NATIVEAOT_JAR }),
    ilspyCmdPath: env.REA_ILSPY_CMD_PATH,
    hopperLauncherPath: env.HOPPER_LAUNCHER_PATH ?? defaultHopperLauncherPath(),
    hopperTargetPath: env.HOPPER_TARGET_PATH,
    hopperTargetKind: env.HOPPER_TARGET_KIND,
    hopperLoaderArgs: loaderArgs.value,
    logLevel: env.REA_LOG_LEVEL,
    referenceSourcePolicy: { secretPatterns: secretPatterns.value },
  });
};
