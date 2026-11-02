import type { ProviderAvailability } from "./AnalysisProvider.js";
import type { JebAnalysisAvailability } from "./jeb/JebAnalysisPort.js";
import type { AvailabilityPolicy } from "./CapabilityInventory.js";
import type { OptionalProviderLoadFailures } from "./OptionalObservationProviders.js";

export interface CapabilityAvailabilityFacts {
  readonly probes?: Partial<CapabilityAvailabilityProbes>;
  readonly observeProviderLoadFailures?: () => OptionalProviderLoadFailures;
  readonly optionalProviderLoadFailures?:
    | OptionalProviderLoadFailures
    | undefined;
  readonly hostUnsupported?: AvailabilityPolicy["hostUnsupported"];
  readonly optionalFeatures?: Pick<
    AvailabilityPolicy,
    | "packetCaptureEnabled"
    | "signalRecordingEnabled"
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

/** Provider-owned live probes used by session discovery. */
export interface CapabilityAvailabilityProbes {
  readonly androidAnalysisAvailability: (
    signal: AbortSignal,
  ) => Promise<ProviderAvailability>;
  readonly adbAnalysisAvailability?: (
    signal: AbortSignal,
  ) => Promise<ProviderAvailability>;
  readonly apktoolAnalysisAvailability?: (
    signal: AbortSignal,
  ) => Promise<ProviderAvailability>;
  readonly jebAnalysisAvailability?: (
    signal: AbortSignal,
  ) => Promise<JebAnalysisAvailability>;
  readonly evmLimiterAvailability?: (
    signal: AbortSignal,
  ) => Promise<ProviderAvailability | undefined>;
}
