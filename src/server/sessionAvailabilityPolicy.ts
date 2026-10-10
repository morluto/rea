import type { AvailabilityPolicy } from "../application/CapabilityInventory.js";
import type { OptionalProviderLoadFailures } from "../application/OptionalObservationProviders.js";
import { platform } from "node:process";

export interface SessionAvailabilityDefaults {
  readonly optionalProviderLoadFailures?:
    | OptionalProviderLoadFailures
    | undefined;
  readonly optionalFeatures?: Pick<
    AvailabilityPolicy,
    | "wasmArtifactEnabled"
    | "evmInterfaceEnabled"
    | "browserObservationEnabled"
    | "browserScenarioEnabled"
    | "electronObservationEnabled"
    | "electronAutomationEnabled"
    | "v8InspectorObservationEnabled"
    | "javascriptRecoveryEnabled"
    | "webModuleResolutionEnabled"
    | "binaryLayoutEnabled"
    | "recordedCrashEnabled"
    | "firmwareInspectionEnabled"
    | "firmwareExtractionEnabled"
  >;
}

/** Select configured availability reporting or the target-free defaults. */
export const sessionAvailabilityPolicy = (
  configured: (() => AvailabilityPolicy) | undefined,
  defaults: SessionAvailabilityDefaults,
): (() => AvailabilityPolicy) => {
  const policy =
    configured ??
    (() => ({
      wasmArtifactEnabled:
        defaults.optionalFeatures?.wasmArtifactEnabled ?? false,
      evmInterfaceEnabled:
        defaults.optionalFeatures?.evmInterfaceEnabled ?? false,
      processCaptureEnabled: platform !== "win32",
      recordedCrashEnabled:
        defaults.optionalFeatures?.recordedCrashEnabled ?? false,
      binaryLayoutEnabled:
        defaults.optionalFeatures?.binaryLayoutEnabled ?? false,
      firmwareInspectionEnabled:
        defaults.optionalFeatures?.firmwareInspectionEnabled ?? false,
      firmwareExtractionEnabled:
        defaults.optionalFeatures?.firmwareExtractionEnabled ?? false,
      javascriptRecoveryEnabled:
        defaults.optionalFeatures?.javascriptRecoveryEnabled ?? false,
      webModuleResolutionEnabled:
        defaults.optionalFeatures?.webModuleResolutionEnabled ?? false,
      browserObservationEnabled:
        defaults.optionalFeatures?.browserObservationEnabled ?? false,
      browserScenarioEnabled:
        defaults.optionalFeatures?.browserScenarioEnabled ?? false,
      electronObservationEnabled:
        defaults.optionalFeatures?.electronObservationEnabled ?? false,
      electronAutomationEnabled:
        defaults.optionalFeatures?.electronAutomationEnabled ?? false,
      v8InspectorObservationEnabled:
        defaults.optionalFeatures?.v8InspectorObservationEnabled ?? false,
    }));
  return () => ({
    ...policy(),
    ...(defaults.optionalProviderLoadFailures === undefined
      ? {}
      : {
          optionalProviderLoadFailures: defaults.optionalProviderLoadFailures,
        }),
  });
};
