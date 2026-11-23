import type { AvailabilityPolicy } from "../application/CapabilityInventory.js";
import {
  HOST_RESTRICTED_FEATURES,
  type HostRestrictedFeature,
} from "../contracts/toolAvailability.js";
import type { CapabilityAvailabilityFacts } from "../application/CapabilityAvailability.js";

/** Either the caller or the observed host can mark an integration unsupported. */
const combineHostUnsupported = (
  configured: AvailabilityPolicy["hostUnsupported"],
  observed: NonNullable<AvailabilityPolicy["hostUnsupported"]>,
): Partial<Record<HostRestrictedFeature, boolean>> => {
  const combined: Partial<Record<HostRestrictedFeature, boolean>> = {};
  for (const feature of HOST_RESTRICTED_FEATURES)
    if (configured?.[feature] === true || observed[feature] === true)
      combined[feature] = true;
  return combined;
};

/** Select configured availability reporting or the target-free defaults. */
export const sessionAvailabilityPolicy = (
  configured: (() => AvailabilityPolicy) | undefined,
  defaults: CapabilityAvailabilityFacts,
  /** The host process capture plans for and runs on. */
  platform: NodeJS.Platform,
): (() => AvailabilityPolicy) => {
  const policy =
    configured ??
    (() => {
      const features = {
        ...defaults.optionalFeatures,
        ...defaults.observeOptionalFeatures?.(),
      };
      return {
        packetCaptureEnabled: features.packetCaptureEnabled ?? false,
        signalRecordingEnabled: features.signalRecordingEnabled ?? false,
        wasmArtifactEnabled: features.wasmArtifactEnabled ?? false,
        evmInterfaceEnabled: features.evmInterfaceEnabled ?? false,
        processCaptureEnabled: platform !== "win32",
        recordedCrashEnabled: features.recordedCrashEnabled ?? false,
        binaryLayoutEnabled: features.binaryLayoutEnabled ?? false,
        firmwareInspectionEnabled: features.firmwareInspectionEnabled ?? false,
        firmwareExtractionEnabled: features.firmwareExtractionEnabled ?? false,
        javascriptRecoveryEnabled: features.javascriptRecoveryEnabled ?? false,
        webModuleResolutionEnabled:
          features.webModuleResolutionEnabled ?? false,
        browserObservationEnabled: features.browserObservationEnabled ?? false,
        browserScenarioEnabled: features.browserScenarioEnabled ?? false,
        electronObservationEnabled:
          features.electronObservationEnabled ?? false,
        electronAutomationEnabled: features.electronAutomationEnabled ?? false,
        v8InspectorObservationEnabled:
          features.v8InspectorObservationEnabled ?? false,
      };
    });
  // Observed host support also bounds a configured policy: no policy lets the
  // default providers pass their execution host checks.
  return () => {
    const value: AvailabilityPolicy = policy();
    return {
      ...value,
      ...(defaults.optionalProviderLoadFailures === undefined
        ? {}
        : {
            optionalProviderLoadFailures: defaults.optionalProviderLoadFailures,
          }),
      ...(defaults.commandProviderFailures === undefined
        ? {}
        : {
            commandProviderFailures: defaults.commandProviderFailures,
          }),
      ...(defaults.hostUnsupported === undefined
        ? {}
        : {
            hostUnsupported: combineHostUnsupported(
              value.hostUnsupported,
              defaults.hostUnsupported,
            ),
          }),
    };
  };
};
