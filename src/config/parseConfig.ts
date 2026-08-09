import { ConfigurationError } from "../domain/errors.js";
import { ok, type Result } from "../domain/result.js";
import { parseEnvironment, type Environment } from "./environment.js";
import {
  parseStringArray,
  parseAbsoluteRoots,
  parseLoaderArgs,
} from "./parsers.js";
import {
  filePolicy,
  permissionScope,
  administratorGrants,
} from "./permissions.js";
import type { AppConfig } from "./types.js";
import type { PermissionCeiling } from "../domain/permissionPolicy.js";
import {
  appendElectronAutomationCeiling,
  parseElectronAutomationPolicy,
  type ElectronAutomationPolicy,
} from "./electronAutomation.js";
import type { ManagedRuntimePolicy } from "../application/ManagedRuntimeCorrelationService.js";
import {
  appendBrowserScenarioCeiling,
  parseBrowserScenarioPolicy,
  type BrowserScenarioPolicy,
} from "./browserScenario.js";
import {
  appendManagedRuntimeCeiling,
  parseManagedRuntimePolicy,
} from "./managedRuntime.js";
import {
  appendJavaScriptReplayCeiling,
  parseJavaScriptReplayPolicy,
} from "./javascriptReplay.js";
import type { JavaScriptReplayPolicy } from "../application/JavaScriptReplayPlanning.js";
import {
  appendProcessCaptureCeiling,
  parseProcessExecutionPolicy,
} from "./processCapture.js";
import type { ProcessExecutionPolicy } from "../domain/processCapture.js";
import {
  appendPassiveObservationCeilings,
  parsePassiveObservationPolicies,
  type PassiveObservationPolicies,
} from "./passiveObservation.js";

const DEFAULT_HOPPER_LAUNCHER_PATH =
  "/Applications/Hopper Disassembler.app/Contents/MacOS/hopper";
const defaultHopperLauncherPath = (): string =>
  process.platform === "linux"
    ? "/opt/hopper/bin/Hopper"
    : DEFAULT_HOPPER_LAUNCHER_PATH;

interface ParsedArrays {
  readonly loaderArgs: readonly string[];
  readonly evidenceRoots: readonly string[];
  readonly investigationInputRoots: readonly string[];
  readonly analysisSnapshotRoots: readonly string[];
  readonly referenceRoots: readonly string[];
  readonly secretPatterns: readonly string[];
  readonly managedRuntimeRoots: readonly string[];
}

interface ParsedPolicies {
  readonly passiveObservation: PassiveObservationPolicies;
  readonly processCapture: ProcessExecutionPolicy;
  readonly browserScenario: BrowserScenarioPolicy;
  readonly electronAutomation: ElectronAutomationPolicy;
  readonly javascriptReplay: JavaScriptReplayPolicy;
  readonly managedRuntime: ManagedRuntimePolicy;
}

const parseAllArrays = (
  env: Environment,
): Result<ParsedArrays, ConfigurationError> => {
  const loaderArgs = parseLoaderArgs(env.HOPPER_LOADER_ARGS_JSON);
  if (!loaderArgs.ok) return loaderArgs;
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
  const managedRuntimeRoots = parseAbsoluteRoots(
    env.REA_MANAGED_RUNTIME_ROOTS_JSON,
    "REA_MANAGED_RUNTIME_ROOTS_JSON",
  );
  if (!managedRuntimeRoots.ok) return managedRuntimeRoots;
  return ok({
    loaderArgs: loaderArgs.value,
    evidenceRoots: evidenceRoots.value,
    investigationInputRoots: investigationInputRoots.value,
    analysisSnapshotRoots: analysisSnapshotRoots.value,
    referenceRoots: referenceRoots.value,
    secretPatterns: secretPatterns.value,
    managedRuntimeRoots: managedRuntimeRoots.value,
  });
};

const appendNativeMountCeiling = (
  ceilings: PermissionCeiling[],
  env: Environment,
): void => {
  if (env.REA_ARTIFACT_NATIVE_MOUNT_ENABLED === "true")
    ceilings.push(permissionScope("native_mount", [], { mount: true }));
};

const buildPermissionCeilings = (
  env: Environment,
  arrays: ParsedArrays,
  policies: ParsedPolicies,
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
  appendProcessCaptureCeiling(ceilings, policies.processCapture);
  appendPassiveObservationCeilings(ceilings, policies.passiveObservation);
  appendBrowserScenarioCeiling(ceilings, policies.browserScenario);
  appendElectronAutomationCeiling(ceilings, policies.electronAutomation);
  appendNativeMountCeiling(ceilings, env);
  appendJavaScriptReplayCeiling(ceilings, policies.javascriptReplay);
  appendManagedRuntimeCeiling(ceilings, policies.managedRuntime);
  return ceilings;
};

const buildAppConfig = (
  env: Environment,
  arrays: ParsedArrays,
  permissionCeilings: readonly PermissionCeiling[],
  policies: ParsedPolicies,
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
  processExecutionPolicy: policies.processCapture,
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
  browserObservationPolicy: policies.passiveObservation.browser,
  browserScenarioPolicy: policies.browserScenario,
  electronObservationPolicy: policies.passiveObservation.electron,
  electronAutomationPolicy: policies.electronAutomation,
  v8InspectorObservationPolicy: policies.passiveObservation.v8Inspector,
  javascriptReplayPolicy: policies.javascriptReplay,
  managedRuntimePolicy: policies.managedRuntime,
  permissionCeilings,
  administratorPermissionGrants: administratorGrants(
    permissionCeilings.filter(
      ({ capability }) =>
        (capability !== "process_capture" ||
          env.REA_PROCESS_CAPTURE_AUTO_GRANT === "true") &&
        (capability !== "browser_automate" ||
          env.REA_BROWSER_SCENARIO_AUTO_GRANT === "true") &&
        (capability !== "electron_automate" ||
          env.REA_ELECTRON_AUTOMATE_AUTO_GRANT === "true"),
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
  const passiveObservationPolicies = parsePassiveObservationPolicies(
    envResult.value,
  );
  if (!passiveObservationPolicies.ok) return passiveObservationPolicies;
  const processCapturePolicy = parseProcessExecutionPolicy(envResult.value);
  if (!processCapturePolicy.ok) return processCapturePolicy;
  const browserScenarioPolicy = parseBrowserScenarioPolicy(envResult.value);
  if (!browserScenarioPolicy.ok) return browserScenarioPolicy;
  const electronAutomationPolicy = parseElectronAutomationPolicy(
    envResult.value,
  );
  if (!electronAutomationPolicy.ok) return electronAutomationPolicy;
  const javascriptReplayPolicy = parseJavaScriptReplayPolicy(envResult.value);
  if (!javascriptReplayPolicy.ok) return javascriptReplayPolicy;
  const managedRuntimePolicy = parseManagedRuntimePolicy(
    envResult.value,
    arraysResult.value.managedRuntimeRoots,
  );
  if (!managedRuntimePolicy.ok) return managedRuntimePolicy;
  const policies = {
    passiveObservation: passiveObservationPolicies.value,
    processCapture: processCapturePolicy.value,
    browserScenario: browserScenarioPolicy.value,
    electronAutomation: electronAutomationPolicy.value,
    javascriptReplay: javascriptReplayPolicy.value,
    managedRuntime: managedRuntimePolicy.value,
  } satisfies ParsedPolicies;
  const permissionCeilings = buildPermissionCeilings(
    envResult.value,
    arraysResult.value,
    policies,
  );
  return ok(
    buildAppConfig(
      envResult.value,
      arraysResult.value,
      permissionCeilings,
      policies,
    ),
  );
};
