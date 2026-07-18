import type { LogLevel } from "../logger.js";
import type { ProcessExecutionPolicy } from "../domain/processCapture.js";
import type { EvidenceFilePolicy } from "../domain/evidenceBundle.js";
import type { ReferenceSourcePolicy } from "../domain/referenceSourcePolicy.js";
import type {
  PermissionCeiling,
  PermissionGrant,
} from "../domain/permissionPolicy.js";
import type { AnalysisProviderSelector } from "../contracts/providerSelection.js";

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
  readonly browserObservationEnabled: boolean;
  readonly browserCdpEndpoints: readonly string[];
  readonly browserAllowedOrigins: readonly string[];
  readonly electronObservationEnabled: boolean;
  readonly electronCdpEndpoints: readonly string[];
  readonly electronFileRoots: readonly string[];
  readonly javascriptReplayPolicy: {
    readonly enabled: boolean;
    readonly roots: readonly string[];
    readonly nodePath: string;
    readonly bubblewrapPath: string;
    readonly systemdRunPath: string;
    readonly systemctlPath: string;
    readonly shellPath: string;
  };
  readonly managedRuntimePolicy: {
    readonly enabled: boolean;
    readonly roots: readonly string[];
    readonly executablePath: string;
  };
  readonly permissionCeilings: readonly PermissionCeiling[];
  readonly administratorPermissionGrants: readonly PermissionGrant[];
  readonly permissionProjectRoot: string | undefined;
  readonly permissionProjectStore: string | undefined;
}
