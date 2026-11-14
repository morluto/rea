import { accessSync, constants, statSync } from "node:fs";

import {
  ConfigurationError,
  type ConfigurationSettingIssue,
} from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  inspectAnalysisSettingSeeds,
  launchAnalysisSetting,
} from "./analysisSettings.js";
import type { AnalysisSettingId } from "../domain/analysisSettings.js";
import { parseEnvironment } from "./environment.js";
import { providerStartupTimeoutSchema } from "./providerStartupTimeout.js";
import { homeDirectoryFromEnvironment } from "./homeDirectory.js";
import {
  DEFAULT_GHIDRA_STARTUP_TIMEOUT_MS,
  DEFAULT_HOPPER_CALLER_SCAN_BUDGET_MS,
  DEFAULT_HOPPER_STARTUP_TIMEOUT_MS,
} from "../domain/analysisResourceLimits.js";
import { DEFAULT_BRIDGE_MAX_REQUEST } from "./bridgeMaxRequestBytes.js";
import { hopperCallerScanBudgetFromEnvironment } from "./hopperCallerScanBudget.js";
import { DEFAULT_REGEX_MATCHING_DEADLINE } from "./regexMatchingDeadline.js";
import { DEFAULT_REGEX_WORKER_HEAP_REQUEST } from "./regexWorkerHeapRequest.js";
import type { AppConfig } from "./types.js";
import { hopperLauncherDiscovery } from "../application/HopperLauncherDiscovery.js";
import { localMacHopperRenamedLauncherCandidates } from "../application/MacHopperPaths.js";
const executableAvailable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

export const defaultHopperLauncherPath = (
  platform: NodeJS.Platform,
  homeDirectory: string,
  executable: (path: string) => boolean = executableAvailable,
): string => {
  const discovery = hopperLauncherDiscovery(platform, homeDirectory);
  for (const candidate of discovery.candidates)
    if (executable(candidate)) return candidate;
  if (discovery.probesMacApplicationBundles)
    for (const candidate of localMacHopperRenamedLauncherCandidates(
      homeDirectory,
    ))
      if (executable(candidate)) return candidate;
  return discovery.fallback;
};

/**
 * Environment native analysis admits. JEB validates its own settings during
 * optional provider composition; that setting must not block unrelated
 * CLI/MCP startup. Registration validation still checks it directly.
 */
const nativeAnalysisEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string | undefined>> => {
  const {
    REA_JEB_MCP_TIMEOUT_MS: _jebTimeout,
    REA_JEB_MCP_URL: _jebUrl,
    ...appEnvironment
  } = environment;
  return appEnvironment;
};

/** Native admission issues and an explicitly configured timeout's independent facts. */
export interface NativeAnalysisConfigurationInspection {
  readonly issues: readonly ConfigurationSettingIssue[];
  readonly configuredHopperStartupTimeout?: Result<number, ConfigurationError>;
}

/** Inspect native admission without probing launchers or losing mixed-invalid diagnostics. */
export const inspectNativeAnalysisConfiguration = (
  environment: Readonly<Record<string, string | undefined>>,
): NativeAnalysisConfigurationInspection => {
  const parsed = parseEnvironment(nativeAnalysisEnvironment(environment));
  const issues = [
    ...(parsed.ok ? [] : parsed.error.settings),
    ...inspectAnalysisSettingSeeds(nativeAnalysisEnvironment(environment)),
  ];
  const configuredTimeout = environment.REA_HOPPER_STARTUP_TIMEOUT_MS;
  if (configuredTimeout === undefined) return { issues };
  const admitted = launchAnalysisSetting(
    "hopper.startup_timeout_ms",
    environment,
  );
  if (parsed.ok && admitted.ok && admitted.value.value !== null)
    return {
      issues,
      configuredHopperStartupTimeout: ok(admitted.value.value),
    };
  // Another setting may reject the aggregate before this supplied timeout's
  // facts are available. Its dedicated diagnostic still uses the same schema.
  const timeout = providerStartupTimeoutSchema.safeParse(configuredTimeout);
  return {
    issues,
    configuredHopperStartupTimeout: timeout.success
      ? ok(timeout.data)
      : err(
          new ConfigurationError("Invalid REA environment configuration", {
            cause: timeout.error,
            settings: timeout.error.issues.map(({ message }) => ({
              setting: "REA_HOPPER_STARTUP_TIMEOUT_MS",
              constraint: message,
            })),
          }),
        ),
  };
};

/** Parse provider configuration and runtime prerequisites at the composition root. */
export const parseConfig = (
  environment: Readonly<Record<string, string | undefined>>,
): Result<AppConfig, ConfigurationError> => {
  const parsed = parseEnvironment(nativeAnalysisEnvironment(environment));
  if (!parsed.ok) return parsed;
  const env = parsed.value;
  const invalidRuntimeSeeds: Partial<
    Record<AnalysisSettingId, ConfigurationError>
  > = {};
  const admitted = (id: AnalysisSettingId): number | null | undefined => {
    const result = launchAnalysisSetting(id, environment);
    if (result.ok) return result.value.value;
    invalidRuntimeSeeds[id] = result.error;
    return undefined;
  };
  const ghidraStartup = admitted("ghidra.startup_timeout_ms");
  const hopperStartup = admitted("hopper.startup_timeout_ms");
  const decompileTimeout = admitted("ghidra.decompile_timeout_seconds");
  const decompilePayload = admitted("ghidra.decompile_max_payload_mib");
  const valueFlowOperations = admitted("ghidra.value_flow_max_operations");
  const valueFlowInputs = admitted(
    "ghidra.value_flow_max_inputs_per_operation",
  );
  const valueFlowEdges = admitted("ghidra.value_flow_max_edges");
  const callerScan = admitted("hopper.caller_scan_budget_ms");
  const bridgeBytes = admitted("bridge.max_request_bytes");
  const regexDeadline = admitted("regex.matching_deadline_ms");
  const regexHeap = admitted("regex.worker_heap_request_mib");
  return ok({
    ...(env.REA_MCP_TOOL_FAMILIES === undefined
      ? {}
      : { mcpToolFamilies: env.REA_MCP_TOOL_FAMILIES }),
    ...(env.REA_MCP_MAX_RESPONSE_BYTES === undefined
      ? {}
      : { mcpMaxResponseBytes: env.REA_MCP_MAX_RESPONSE_BYTES }),
    ...(env.REA_MCP_MAX_INPUT_ELEMENTS === undefined
      ? {}
      : { mcpMaxInputElements: env.REA_MCP_MAX_INPUT_ELEMENTS }),
    ...(env.REA_MCP_INPUT_SCHEMA_PROFILE === undefined
      ? {}
      : { mcpInputSchemaProfile: env.REA_MCP_INPUT_SCHEMA_PROFILE }),
    ...(env.REA_MCP_OUTPUT_SCHEMA_PROFILE === undefined
      ? {}
      : { mcpOutputSchemaProfile: env.REA_MCP_OUTPUT_SCHEMA_PROFILE }),
    ...(env.REA_MCP_TOOL_CATALOG_PROFILE === undefined
      ? {}
      : { mcpToolCatalogProfile: env.REA_MCP_TOOL_CATALOG_PROFILE }),
    analysisProvider: env.REA_ANALYSIS_PROVIDER,
    ...(env.REA_IDA_MCP_CONFIG === undefined
      ? {}
      : { idaMcpConfigPath: env.REA_IDA_MCP_CONFIG }),
    ...(env.REA_BINARY_NINJA_MCP_CONFIG === undefined
      ? {}
      : { binaryNinjaMcpConfigPath: env.REA_BINARY_NINJA_MCP_CONFIG }),
    ...(env.REA_GHIDRA_PROJECT_PATH === undefined
      ? {}
      : {
          ghidraExistingProject: {
            path: env.REA_GHIDRA_PROJECT_PATH,
            ...(env.REA_GHIDRA_PROGRAM_NAME === undefined
              ? {}
              : { programName: env.REA_GHIDRA_PROGRAM_NAME }),
          },
        }),
    ghidraInstallDir: env.GHIDRA_INSTALL_DIR,
    ...(env.REA_GHIDRA_CHECKPOINT_DIR === undefined
      ? {}
      : { ghidraCheckpointDirectory: env.REA_GHIDRA_CHECKPOINT_DIR }),
    ghidraJavaHome: env.JAVA_HOME,
    ghidraStartupTimeoutMs: ghidraStartup ?? DEFAULT_GHIDRA_STARTUP_TIMEOUT_MS,
    ...(decompilePayload === undefined || decompilePayload === null
      ? {}
      : { ghidraDecompileMaxPayloadMiB: decompilePayload }),
    ...(valueFlowOperations === undefined || valueFlowOperations === null
      ? {}
      : { ghidraValueFlowMaxOperations: valueFlowOperations }),
    ...(valueFlowInputs === undefined || valueFlowInputs === null
      ? {}
      : { ghidraValueFlowMaxInputsPerOperation: valueFlowInputs }),
    ...(valueFlowEdges === undefined || valueFlowEdges === null
      ? {}
      : { ghidraValueFlowMaxEdges: valueFlowEdges }),
    ...(decompileTimeout === undefined || decompileTimeout === null
      ? {}
      : { ghidraDecompileTimeoutSeconds: decompileTimeout }),
    ...(env.REA_GHIDRA_LANGUAGE_ID === undefined
      ? {}
      : {
          ghidraLanguageOverride: {
            languageId: env.REA_GHIDRA_LANGUAGE_ID,
            ...(env.REA_GHIDRA_COMPILER_SPEC_ID === undefined
              ? {}
              : { compilerSpecId: env.REA_GHIDRA_COMPILER_SPEC_ID }),
          },
        }),
    ...(env.REA_GHIDRA_SEED_FILE === undefined
      ? {}
      : { ghidraSeedFile: env.REA_GHIDRA_SEED_FILE }),
    ...(env.REA_GHIDRA_DISABLED_ANALYZERS === undefined
      ? {}
      : { ghidraDisabledAnalyzers: env.REA_GHIDRA_DISABLED_ANALYZERS }),
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
    hopperStartupTimeoutMs: hopperStartup ?? DEFAULT_HOPPER_STARTUP_TIMEOUT_MS,
    hopperStartupTimeoutSource:
      environment.REA_HOPPER_STARTUP_TIMEOUT_MS === undefined ||
      hopperStartup === undefined
        ? "default"
        : "setting",
    hopperCallerScanBudget: hopperCallerScanBudgetFromEnvironment(
      callerScan === undefined ||
        environment.REA_HOPPER_CALLER_SCAN_BUDGET_MS === undefined
        ? undefined
        : environment.REA_HOPPER_CALLER_SCAN_BUDGET_MS,
      callerScan ?? DEFAULT_HOPPER_CALLER_SCAN_BUDGET_MS,
    ),
    hopperTargetPath: env.HOPPER_TARGET_PATH,
    hopperTargetKind: env.HOPPER_TARGET_KIND,
    hopperLoaderArgs: env.loaderArgs,
    logLevel: env.REA_LOG_LEVEL,
    referenceSourcePolicy: {
      secretPatterns: env.referenceSecretPatterns,
    },
    bridgeMaxRequestBytes:
      bridgeBytes === undefined ||
      bridgeBytes === null ||
      environment.REA_BRIDGE_MAX_REQUEST_BYTES === undefined
        ? DEFAULT_BRIDGE_MAX_REQUEST
        : {
            maximumBytes: bridgeBytes,
            source: "setting",
          },
    regexMatchingDeadline:
      regexDeadline === undefined ||
      regexDeadline === null ||
      environment.REA_REGEX_MATCHING_DEADLINE_MS === undefined
        ? DEFAULT_REGEX_MATCHING_DEADLINE
        : {
            deadlineMs: regexDeadline,
            source: "setting",
          },
    regexWorkerHeapRequest:
      regexHeap === undefined ||
      regexHeap === null ||
      environment.REA_REGEX_WORKER_HEAP_REQUEST_MIB === undefined
        ? DEFAULT_REGEX_WORKER_HEAP_REQUEST
        : {
            heapMiB: regexHeap,
            source: "setting",
          },
    invalidRuntimeSeeds,
  });
};
