import type { AvailabilityPolicy } from "../application/CapabilityInventory.js";
import type { OptionalProviderLoadFailures } from "../application/OptionalObservationProviders.js";
import { platform } from "node:process";

export type SessionAvailability = AvailabilityPolicy;

export interface SessionAvailabilityDefaults {
  readonly optionalProviderLoadFailures?:
    | OptionalProviderLoadFailures
    | undefined;
  readonly optionalFeatures?: Pick<
    SessionAvailability,
    | "evmInterfaceEnabled"
    | "browserObservationEnabled"
    | "browserScenarioEnabled"
    | "electronObservationEnabled"
    | "electronAutomationEnabled"
    | "v8InspectorObservationEnabled"
    | "androidAnalysisEnabled"
    | "javascriptRecoveryEnabled"
    | "webModuleResolutionEnabled"
    | "binaryLayoutEnabled"
    | "firmwareInspectionEnabled"
    | "firmwareExtractionEnabled"
  >;
}

/** Select configured availability reporting or the target-free defaults. */
export const sessionAvailabilityPolicy = (
  configured: (() => SessionAvailability) | undefined,
  defaults: SessionAvailabilityDefaults,
): (() => SessionAvailability) => {
  const policy =
    configured ??
    (() => ({
      evmInterfaceEnabled:
        defaults.optionalFeatures?.evmInterfaceEnabled ?? false,
      processCaptureEnabled: platform !== "win32",
      binaryLayoutEnabled:
        defaults.optionalFeatures?.binaryLayoutEnabled ?? false,
      firmwareInspectionEnabled:
        defaults.optionalFeatures?.firmwareInspectionEnabled ?? false,
      firmwareExtractionEnabled:
        defaults.optionalFeatures?.firmwareExtractionEnabled ?? false,
      androidAnalysisEnabled:
        defaults.optionalFeatures?.androidAnalysisEnabled ?? false,
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
