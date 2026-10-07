import type { ProviderIdentity } from "../AnalysisProvider.js";
import {
  createEvidence,
  type Evidence,
  type EvidenceObservation,
} from "../../domain/evidence.js";
import { jsonValueSchema } from "../../domain/jsonValue.js";
import type {
  ElectronPageInspection,
  ElectronTargetList,
  InspectElectronPageInput,
  ListElectronTargetsInput,
} from "../../domain/javascript/electronObservation.js";

type ElectronOperation = "list_electron_targets" | "inspect_electron_page";

/** Create Evidence for one Electron observation. */
export const createElectronEvidence = (
  operation: ElectronOperation,
  input: ListElectronTargetsInput | InspectElectronPageInput,
  result: ElectronTargetList | ElectronPageInspection,
  provider: ProviderIdentity,
): Evidence =>
  createEvidence(undefined, provider, {
    predicateType:
      operation === "list_electron_targets"
        ? "rea.electron-target-list"
        : "rea.electron-page-inspection",
    operation,
    parameters: parameters(input),
    result: jsonValueSchema.parse(result),
    confidence: "observed",
    authority: "external-service",
    environment:
      "target" in result
        ? {
            id: `${result.browser.product}@${result.browser.revision}`,
            platform: "unknown",
            architecture: "unknown",
            isolation: "none",
          }
        : null,
    limitations: [
      ...result.limitations,
      ...("target" in result
        ? ["Browser host platform and architecture were not observed."]
        : []),
    ],
  });

const parameters = (
  input: ListElectronTargetsInput | InspectElectronPageInput,
): EvidenceObservation["parameters"] => ({
  cdp_endpoint: input.cdp_endpoint,
  ...("target_id" in input
    ? {
        target_id: input.target_id,
        observation_ms: input.observation_ms,
        include_script_sources: input.include_script_sources,
      }
    : {}),
});
