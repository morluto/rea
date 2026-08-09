import type { AvailabilityPolicy } from "../application/CapabilityInventory.js";
import type { EvidenceFilePolicy } from "../domain/evidenceBundle.js";
import type { ProcessExecutionPolicy } from "../domain/processCapture.js";

export type SessionAvailability = AvailabilityPolicy;

export interface SessionAvailabilityDefaults {
  readonly processPolicy: ProcessExecutionPolicy;
  readonly evidenceFilePolicy: EvidenceFilePolicy;
  readonly investigationInputRoots: readonly string[];
  readonly optionalFeatures?: Pick<
    SessionAvailability,
    | "browserObservationEnabled"
    | "browserScenarioEnabled"
    | "electronObservationEnabled"
    | "electronAutomationEnabled"
    | "v8InspectorObservationEnabled"
    | "javascriptReplayEnabled"
    | "managedRuntimeEnabled"
  >;
}

/** Select configured availability reporting or the target-free defaults. */
export const sessionAvailabilityPolicy = (
  configured: (() => SessionAvailability) | undefined,
  defaults: SessionAvailabilityDefaults,
): (() => SessionAvailability) =>
  configured ??
  (() => ({
    processCaptureEnabled: defaults.processPolicy.status === "enabled",
    evidenceFileRoots: defaults.evidenceFilePolicy.roots.length,
    investigationInputRoots: defaults.investigationInputRoots.length,
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
    javascriptReplayEnabled:
      defaults.optionalFeatures?.javascriptReplayEnabled ?? false,
    managedRuntimeEnabled:
      defaults.optionalFeatures?.managedRuntimeEnabled ?? false,
  }));
