import type { LogLevel } from "../logger.js";
import type { ProcessExecutionPolicy } from "../domain/processCapture.js";
import type { EvidenceFilePolicy } from "../domain/evidenceBundle.js";
import type { ReferenceSourcePolicy } from "../domain/referenceSourcePolicy.js";
import type {
  PermissionCeiling,
  PermissionGrant,
} from "../domain/permissionPolicy.js";
import type { AnalysisProviderSelector } from "../contracts/providerSelection.js";
import type { ManagedRuntimePolicy } from "../application/ManagedRuntimeCorrelationService.js";
import type { JavaScriptReplayPolicy } from "../application/JavaScriptReplayPlanning.js";
import type { ElectronAutomationPolicy } from "./electronAutomation.js";
import type { BrowserScenarioPolicy } from "./browserScenario.js";
import type {
  BrowserObservationPolicy,
  ElectronObservationPolicy,
  V8InspectorObservationPolicy,
} from "./passiveObservation.js";

export interface AppConfig {
  readonly analysisProvider: AnalysisProviderSelector;
  readonly ghidraInstallDir: string | undefined;
  readonly ghidraJavaHome: string | undefined;
  readonly ilspyCmdPath: string | undefined;
  readonly hopperLauncherPath: string;
  readonly hopperTargetPath: string | undefined;
  readonly hopperTargetKind: "executable" | "database";
  readonly hopperLoaderArgs: readonly string[];
  readonly logLevel: LogLevel;
  readonly processExecutionPolicy: ProcessExecutionPolicy;
  readonly artifactNativeMountEnabled: boolean;
  readonly artifactIntegrityContinueEnabled: boolean;
  readonly evidenceFilePolicy: EvidenceFilePolicy;
  readonly investigationInputRoots: readonly string[];
  readonly analysisSnapshotFilePolicy: EvidenceFilePolicy;
  readonly referenceSourcePolicy: ReferenceSourcePolicy;
  readonly browserObservationPolicy: BrowserObservationPolicy;
  readonly browserScenarioPolicy: BrowserScenarioPolicy;
  readonly electronObservationPolicy: ElectronObservationPolicy;
  readonly electronAutomationPolicy: ElectronAutomationPolicy;
  readonly v8InspectorObservationPolicy: V8InspectorObservationPolicy;
  readonly javascriptReplayPolicy: JavaScriptReplayPolicy;
  readonly managedRuntimePolicy: ManagedRuntimePolicy;
  readonly permissionCeilings: readonly PermissionCeiling[];
  readonly administratorPermissionGrants: readonly PermissionGrant[];
  readonly permissionProjectRoot: string | undefined;
  readonly permissionProjectStore: string | undefined;
}
