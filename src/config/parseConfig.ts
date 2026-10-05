import { ConfigurationError } from "../domain/errors.js";
import { ok, type Result } from "../domain/result.js";
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
  const loaderArgs = parseLoaderArgs(env.HOPPER_LOADER_ARGS_JSON);
  if (!loaderArgs.ok) return loaderArgs;
  const secretPatterns = parseStringArray(
    env.REA_REFERENCE_SECRET_PATTERNS_JSON,
    "REA_REFERENCE_SECRET_PATTERNS_JSON",
  );
  if (!secretPatterns.ok) return secretPatterns;
  return ok({
    analysisProvider: env.REA_ANALYSIS_PROVIDER,
    ghidraInstallDir: env.GHIDRA_INSTALL_DIR,
    ghidraJavaHome: env.JAVA_HOME,
    ilspyCmdPath: env.REA_ILSPY_CMD_PATH,
    hopperLauncherPath: env.HOPPER_LAUNCHER_PATH ?? defaultHopperLauncherPath(),
    hopperTargetPath: env.HOPPER_TARGET_PATH,
    hopperTargetKind: env.HOPPER_TARGET_KIND,
    hopperLoaderArgs: loaderArgs.value,
    logLevel: env.REA_LOG_LEVEL,
    referenceSourcePolicy: { secretPatterns: secretPatterns.value },
    javascriptReplayConfiguration: {
      nodePath: env.REA_JAVASCRIPT_REPLAY_NODE_PATH,
      bubblewrapPath: env.REA_JAVASCRIPT_REPLAY_BWRAP_PATH,
      systemdRunPath: env.REA_JAVASCRIPT_REPLAY_SYSTEMD_RUN_PATH,
      systemctlPath: env.REA_JAVASCRIPT_REPLAY_SYSTEMCTL_PATH,
      shellPath: env.REA_JAVASCRIPT_REPLAY_SHELL_PATH,
    },
    managedRuntimeConfiguration: {
      executablePath: env.REA_MANAGED_RUNTIME_EXECUTABLE_PATH,
    },
  });
};
