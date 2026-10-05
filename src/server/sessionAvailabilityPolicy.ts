import type { AvailabilityPolicy } from "../application/CapabilityInventory.js";
import { arch, platform } from "node:process";
import { isSupportedControlledReplayHost } from "../application/ControlledReplayHostSupport.js";

export type SessionAvailability = AvailabilityPolicy;

export interface SessionAvailabilityDefaults {
  readonly optionalFeatures?: Pick<
    SessionAvailability,
    | "browserObservationEnabled"
    | "browserScenarioEnabled"
    | "electronObservationEnabled"
    | "electronAutomationEnabled"
    | "v8InspectorObservationEnabled"
  >;
}

/** Select configured availability reporting or the target-free defaults. */
export const sessionAvailabilityPolicy = (
  configured: (() => SessionAvailability) | undefined,
  defaults: SessionAvailabilityDefaults,
): (() => SessionAvailability) =>
  configured ??
  (() => ({
    processCaptureEnabled: platform !== "win32",
    controlledReplayEnabled: isSupportedControlledReplayHost(platform, arch),
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
