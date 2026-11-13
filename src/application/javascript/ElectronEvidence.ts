import { isDeepStrictEqual } from "node:util";
import type { JsonValue } from "../../domain/jsonValue.js";
import type { ProviderIdentity } from "../AnalysisProvider.js";
import {
  createEvidence,
  type Evidence,
  type EvidenceObservation,
} from "../../domain/evidence.js";
import type {
  ElectronPageInspection,
  ElectronTargetList,
  InspectElectronPageInput,
  ListElectronTargetsInput,
} from "../../domain/javascript/electronObservation.js";

/** Own JSON source and the facts admitted by the named Electron output contract. */
export interface ElectronEvidenceReport {
  readonly source: JsonValue;
  readonly facts: ElectronTargetList | ElectronPageInspection;
}

type ElectronOperation = "list_electron_targets" | "inspect_electron_page";

/** Create Evidence for one Electron observation. */
export const createElectronEvidence = (
  operation: ElectronOperation,
  input: ListElectronTargetsInput | InspectElectronPageInput,
  report: ElectronEvidenceReport,
  provider: ProviderIdentity,
): Evidence => {
  const result = report.facts;
  return createEvidence(undefined, provider, {
    predicateType:
      operation === "list_electron_targets"
        ? "rea.electron-target-list"
        : "rea.electron-page-inspection",
    operation,
    parameters: parameters(input),
    result,
    rawResult: isDeepStrictEqual(report.source, result) ? null : report.source,
    confidence: "observed",
    authority: "external-service",
    environment: {
      id: `${result.browser.product}@${result.browser.revision}`,
      platform: "unknown",
      architecture: "unknown",
      isolation: "none",
    },
    limitations: [
      ...result.limitations,
      "Browser host platform and architecture were not observed.",
    ],
  });
};

const parameters = (
  input: ListElectronTargetsInput | InspectElectronPageInput,
): EvidenceObservation["parameters"] => ({
  cdp_endpoint: input.cdp_endpoint,
  ...("target_id" in input
    ? {
        target_id: input.target_id,
        observation_ms: input.observation_ms,
        include_script_sources: input.include_script_sources,
        ...(input.command_timeout_ms === undefined
          ? {}
          : { command_timeout_ms: input.command_timeout_ms }),
      }
    : {}),
});
