import { isAbsolute } from "node:path";

import { ConfigurationError } from "../domain/errors.js";
import { err, ok, type Result } from "../domain/result.js";
import { parseEnvironment, type Environment } from "./environment.js";
import {
  parseStringArray,
  parseBrowserArray,
  parseElectronFileRoots,
  parseLoaderArgs,
} from "./parsers.js";
import {
  filePolicy,
  permissionScope,
  administratorGrants,
  browserNetworkScope,
} from "./permissions.js";
import type { AppConfig } from "./types.js";
import type { PermissionCeiling } from "../domain/permissionPolicy.js";
import {
  browserEndpointSchema,
  browserOriginSchema,
} from "../domain/browserObservation.js";

const DEFAULT_HOPPER_LAUNCHER_PATH =
  "/Applications/Hopper Disassembler.app/Contents/MacOS/hopper";
const defaultHopperLauncherPath = (): string =>
  process.platform === "linux"
    ? "/opt/hopper/bin/Hopper"
    : DEFAULT_HOPPER_LAUNCHER_PATH;

interface ParsedArrays {
  readonly loaderArgs: readonly string[];
  readonly executableRoots: readonly string[];
  readonly workingRoots: readonly string[];
  readonly allowedEnvironment: readonly string[];
  readonly evidenceRoots: readonly string[];
  readonly investigationInputRoots: readonly string[];
  readonly analysisSnapshotRoots: readonly string[];
  readonly referenceRoots: readonly string[];
  readonly secretPatterns: readonly string[];
  readonly browserEndpoints: readonly string[];
  readonly browserOrigins: readonly string[];
  readonly electronEndpoints: readonly string[];
  readonly electronFileRoots: readonly string[];
  readonly javascriptReplayRoots: readonly string[];
  readonly managedRuntimeRoots: readonly string[];
}

const parseAllArrays = (
  env: Environment,
): Result<ParsedArrays, ConfigurationError> => {
  const loaderArgs = parseLoaderArgs(env.HOPPER_LOADER_ARGS_JSON);
  if (!loaderArgs.ok) return loaderArgs;
  const executableRoots = parseStringArray(
    env.REA_PROCESS_EXECUTABLE_ROOTS_JSON,
    "REA_PROCESS_EXECUTABLE_ROOTS_JSON",
  );
  if (!executableRoots.ok) return executableRoots;
  const workingRoots = parseStringArray(
    env.REA_PROCESS_WORKING_ROOTS_JSON,
    "REA_PROCESS_WORKING_ROOTS_JSON",
  );
  if (!workingRoots.ok) return workingRoots;
  const allowedEnvironment = parseStringArray(
    env.REA_PROCESS_ALLOWED_ENV_JSON,
    "REA_PROCESS_ALLOWED_ENV_JSON",
  );
  if (!allowedEnvironment.ok) return allowedEnvironment;
  const evidenceRoots = parseStringArray(
    env.REA_EVIDENCE_ROOTS_JSON,
    "REA_EVIDENCE_ROOTS_JSON",
  );
  if (!evidenceRoots.ok) return evidenceRoots;
  const investigationInputRoots = parseStringArray(
    env.REA_INVESTIGATION_INPUT_ROOTS_JSON,
    "REA_INVESTIGATION_INPUT_ROOTS_JSON",
  );
  if (!investigationInputRoots.ok) return investigationInputRoots;
  const analysisSnapshotRoots = parseStringArray(
    env.REA_ANALYSIS_SNAPSHOT_ROOTS_JSON,
    "REA_ANALYSIS_SNAPSHOT_ROOTS_JSON",
  );
  if (!analysisSnapshotRoots.ok) return analysisSnapshotRoots;
  const referenceRoots = parseStringArray(
    env.REA_REFERENCE_ROOTS_JSON,
    "REA_REFERENCE_ROOTS_JSON",
  );
  if (!referenceRoots.ok) return referenceRoots;
  const secretPatterns = parseStringArray(
    env.REA_REFERENCE_SECRET_PATTERNS_JSON,
    "REA_REFERENCE_SECRET_PATTERNS_JSON",
  );
  if (!secretPatterns.ok) return secretPatterns;
  const browserEndpoints = parseBrowserArray(
    env.REA_BROWSER_CDP_ENDPOINTS_JSON,
    "REA_BROWSER_CDP_ENDPOINTS_JSON",
    browserEndpointSchema,
    16,
  );
  if (!browserEndpoints.ok) return browserEndpoints;
  const browserOrigins = parseBrowserArray(
    env.REA_BROWSER_ALLOWED_ORIGINS_JSON,
    "REA_BROWSER_ALLOWED_ORIGINS_JSON",
    browserOriginSchema,
    32,
  );
  if (!browserOrigins.ok) return browserOrigins;
  const electronEndpoints = parseBrowserArray(
    env.REA_ELECTRON_CDP_ENDPOINTS_JSON,
    "REA_ELECTRON_CDP_ENDPOINTS_JSON",
    browserEndpointSchema,
    16,
  );
  if (!electronEndpoints.ok) return electronEndpoints;
  const electronFileRoots = parseElectronFileRoots(
    env.REA_ELECTRON_FILE_ROOTS_JSON,
  );
  if (!electronFileRoots.ok) return electronFileRoots;
  const javascriptReplayRoots = parseAbsoluteRoots(
    env.REA_JAVASCRIPT_REPLAY_ROOTS_JSON,
    "REA_JAVASCRIPT_REPLAY_ROOTS_JSON",
  );
  if (!javascriptReplayRoots.ok) return javascriptReplayRoots;
  const managedRuntimeRoots = parseAbsoluteRoots(
    env.REA_MANAGED_RUNTIME_ROOTS_JSON,
    "REA_MANAGED_RUNTIME_ROOTS_JSON",
  );
  if (!managedRuntimeRoots.ok) return managedRuntimeRoots;
  return ok({
    loaderArgs: loaderArgs.value,
    executableRoots: executableRoots.value,
    workingRoots: workingRoots.value,
    allowedEnvironment: allowedEnvironment.value,
    evidenceRoots: evidenceRoots.value,
    investigationInputRoots: investigationInputRoots.value,
    analysisSnapshotRoots: analysisSnapshotRoots.value,
    referenceRoots: referenceRoots.value,
    secretPatterns: secretPatterns.value,
    browserEndpoints: browserEndpoints.value,
    browserOrigins: browserOrigins.value,
    electronEndpoints: electronEndpoints.value,
    electronFileRoots: electronFileRoots.value,
    javascriptReplayRoots: javascriptReplayRoots.value,
    managedRuntimeRoots: managedRuntimeRoots.value,
  });
};

const parseAbsoluteRoots = (
  value: string,
  name: string,
): Result<readonly string[], ConfigurationError> => {
  const parsed = parseStringArray(value, name);
  if (!parsed.ok) return parsed;
  return parsed.value.some((root) => !isAbsolute(root))
    ? err(new ConfigurationError(`${name} must encode absolute roots`))
    : parsed;
};

const appendProcessCaptureCeiling = (
  ceilings: PermissionCeiling[],
  env: Environment,
  arrays: ParsedArrays,
): void => {
  if (env.REA_PROCESS_CAPTURE_ENABLED !== "true") return;
  ceilings.push(
    permissionScope("process_capture", arrays.workingRoots, {
      executables: arrays.executableRoots,
      environment_names: arrays.allowedEnvironment,
      network:
        env.REA_PROCESS_ALLOW_EXTERNAL_NETWORK === "true" ? "external" : "none",
    }),
  );
};

const appendBrowserObservationCeiling = (
  ceilings: PermissionCeiling[],
  env: Environment,
  arrays: ParsedArrays,
): void => {
  if (env.REA_BROWSER_OBSERVE_ENABLED !== "true") return;
  ceilings.push(
    permissionScope("browser_observe", [], {
      origins: [...arrays.browserEndpoints, ...arrays.browserOrigins],
      network: browserNetworkScope(arrays.browserOrigins),
    }),
  );
};

const appendElectronObservationCeiling = (
  ceilings: PermissionCeiling[],
  env: Environment,
  arrays: ParsedArrays,
): void => {
  if (env.REA_ELECTRON_OBSERVE_ENABLED !== "true") return;
  ceilings.push(
    permissionScope("electron_observe", arrays.electronFileRoots, {
      origins: arrays.electronEndpoints,
      network: "loopback",
    }),
  );
};

const appendNativeMountCeiling = (
  ceilings: PermissionCeiling[],
  env: Environment,
): void => {
  if (env.REA_ARTIFACT_NATIVE_MOUNT_ENABLED === "true")
    ceilings.push(permissionScope("native_mount", [], { mount: true }));
};

const appendJavaScriptReplayCeiling = (
  ceilings: PermissionCeiling[],
  env: Environment,
  arrays: ParsedArrays,
): void => {
  if (env.REA_JAVASCRIPT_REPLAY_ENABLED !== "true") return;
  ceilings.push(
    permissionScope("javascript_replay", arrays.javascriptReplayRoots, {
      executables: [
        env.REA_JAVASCRIPT_REPLAY_NODE_PATH,
        env.REA_JAVASCRIPT_REPLAY_BWRAP_PATH,
        env.REA_JAVASCRIPT_REPLAY_SYSTEMD_RUN_PATH,
        env.REA_JAVASCRIPT_REPLAY_SYSTEMCTL_PATH,
        env.REA_JAVASCRIPT_REPLAY_SHELL_PATH,
      ],
      network: "none",
      mount: true,
    }),
  );
};

const appendManagedRuntimeCeiling = (
  ceilings: PermissionCeiling[],
  env: Environment,
  arrays: ParsedArrays,
): void => {
  if (env.REA_MANAGED_RUNTIME_ENABLED !== "true") return;
  ceilings.push(
    permissionScope("managed_runtime", arrays.managedRuntimeRoots, {
      executables: [env.REA_MANAGED_RUNTIME_EXECUTABLE_PATH],
      network: "none",
    }),
  );
};

const buildPermissionCeilings = (
  env: Environment,
  arrays: ParsedArrays,
): readonly PermissionCeiling[] => {
  const ceilings: PermissionCeiling[] = [
    permissionScope("evidence_read", arrays.evidenceRoots),
    permissionScope("evidence_write", arrays.evidenceRoots),
    permissionScope("investigation_input", arrays.investigationInputRoots),
    permissionScope("investigation_workspace_read", arrays.evidenceRoots),
    permissionScope("investigation_workspace_write", arrays.evidenceRoots),
    permissionScope("snapshot_read", arrays.analysisSnapshotRoots),
    permissionScope("snapshot_write", arrays.analysisSnapshotRoots),
    permissionScope("artifact_extract", ["/"]),
    permissionScope("reference_read", arrays.referenceRoots),
  ];
  appendProcessCaptureCeiling(ceilings, env, arrays);
  appendBrowserObservationCeiling(ceilings, env, arrays);
  appendElectronObservationCeiling(ceilings, env, arrays);
  appendNativeMountCeiling(ceilings, env);
  appendJavaScriptReplayCeiling(ceilings, env, arrays);
  appendManagedRuntimeCeiling(ceilings, env, arrays);
  return ceilings;
};

const buildAppConfig = (
  env: Environment,
  arrays: ParsedArrays,
  permissionCeilings: readonly PermissionCeiling[],
): AppConfig => ({
  analysisProvider: env.REA_ANALYSIS_PROVIDER,
  ghidraInstallDir: env.GHIDRA_INSTALL_DIR,
  ghidraJavaHome: env.JAVA_HOME,
  ilspyCmdPath: env.REA_ILSPY_CMD_PATH,
  hopperLauncherPath: env.HOPPER_LAUNCHER_PATH ?? defaultHopperLauncherPath(),
  hopperTargetPath: env.HOPPER_TARGET_PATH,
  hopperTargetKind: env.HOPPER_TARGET_KIND,
  hopperLoaderArgs: arrays.loaderArgs,
  logLevel: env.REA_LOG_LEVEL,
  processExecutionPolicy: {
    enabled: env.REA_PROCESS_CAPTURE_ENABLED === "true",
    executableRoots: arrays.executableRoots,
    workingRoots: arrays.workingRoots,
    allowedEnvironment: arrays.allowedEnvironment,
    allowExternalNetwork: env.REA_PROCESS_ALLOW_EXTERNAL_NETWORK === "true",
  },
  artifactNativeMountEnabled: env.REA_ARTIFACT_NATIVE_MOUNT_ENABLED === "true",
  artifactIntegrityContinueEnabled:
    env.REA_ARTIFACT_INTEGRITY_CONTINUE_ENABLED === "true",
  evidenceFilePolicy: filePolicy(arrays.evidenceRoots),
  investigationInputRoots: arrays.investigationInputRoots,
  analysisSnapshotFilePolicy: filePolicy(arrays.analysisSnapshotRoots),
  referenceSourcePolicy: {
    roots: arrays.referenceRoots,
    secretPatterns: arrays.secretPatterns,
    maxBytes: 16 * 1024 * 1024,
    maxEntries: 10_000,
    maxDepth: 32,
    maxPathBytes: 4_096,
  },
  browserObservationEnabled: env.REA_BROWSER_OBSERVE_ENABLED === "true",
  browserCdpEndpoints: arrays.browserEndpoints,
  browserAllowedOrigins: arrays.browserOrigins,
  electronObservationEnabled: env.REA_ELECTRON_OBSERVE_ENABLED === "true",
  electronCdpEndpoints: arrays.electronEndpoints,
  electronFileRoots: arrays.electronFileRoots,
  javascriptReplayPolicy: {
    enabled: env.REA_JAVASCRIPT_REPLAY_ENABLED === "true",
    roots: arrays.javascriptReplayRoots,
    nodePath: env.REA_JAVASCRIPT_REPLAY_NODE_PATH,
    bubblewrapPath: env.REA_JAVASCRIPT_REPLAY_BWRAP_PATH,
    systemdRunPath: env.REA_JAVASCRIPT_REPLAY_SYSTEMD_RUN_PATH,
    systemctlPath: env.REA_JAVASCRIPT_REPLAY_SYSTEMCTL_PATH,
    shellPath: env.REA_JAVASCRIPT_REPLAY_SHELL_PATH,
  },
  managedRuntimePolicy: {
    enabled: env.REA_MANAGED_RUNTIME_ENABLED === "true",
    roots: arrays.managedRuntimeRoots,
    executablePath: env.REA_MANAGED_RUNTIME_EXECUTABLE_PATH,
  },
  permissionCeilings,
  administratorPermissionGrants: administratorGrants(
    env.REA_PROCESS_CAPTURE_AUTO_GRANT === "true"
      ? permissionCeilings
      : permissionCeilings.filter(
          ({ capability }) => capability !== "process_capture",
        ),
  ),
  permissionProjectRoot: env.REA_PERMISSION_PROJECT_ROOT,
  permissionProjectStore: env.REA_PERMISSION_PROJECT_STORE,
});

/**
 * Parse provider and authority configuration once at the composition root.
 * Explicit loader arguments override REA's header-derived defaults for a
 * supported target, allowing callers to refine Hopper's loader behavior without
 * bypassing REA's path and executable-header checks.
 */
export const parseConfig = (
  environment: Readonly<Record<string, string | undefined>>,
): Result<AppConfig, ConfigurationError> => {
  const envResult = parseEnvironment(environment);
  if (!envResult.ok) return envResult;
  const arraysResult = parseAllArrays(envResult.value);
  if (!arraysResult.ok) return arraysResult;
  const permissionCeilings = buildPermissionCeilings(
    envResult.value,
    arraysResult.value,
  );
  return ok(
    buildAppConfig(envResult.value, arraysResult.value, permissionCeilings),
  );
};
