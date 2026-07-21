import type { EvidenceFilePolicy } from "../domain/evidenceBundle.js";
import type { ProcessExecutionPolicy } from "../domain/processCapture.js";

export interface SessionAvailability {
  readonly processCaptureEnabled: boolean;
  readonly evidenceFileRoots: number;
  readonly investigationInputRoots: number;
  readonly browserObservationEnabled?: boolean;
  readonly electronObservationEnabled?: boolean;
  readonly javascriptReplayEnabled?: boolean;
  readonly managedRuntimeEnabled?: boolean;
}

/** Select configured availability reporting or the target-free defaults. */
export const sessionAvailabilityPolicy = (
  configured: (() => SessionAvailability) | undefined,
  processPolicy: ProcessExecutionPolicy,
  evidenceFilePolicy: EvidenceFilePolicy,
  investigationInputRoots: readonly string[],
): (() => SessionAvailability) =>
  configured ??
  (() => ({
    processCaptureEnabled: processPolicy.enabled,
    evidenceFileRoots: evidenceFilePolicy.roots.length,
    investigationInputRoots: investigationInputRoots.length,
    browserObservationEnabled: false,
    electronObservationEnabled: false,
    javascriptReplayEnabled: false,
    managedRuntimeEnabled: false,
  }));
