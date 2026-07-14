import type { ProviderIdentity } from "./AnalysisProvider.js";
import {
  createEvidence,
  type Evidence,
  type EvidenceObservation,
} from "../domain/evidence.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import type {
  ElectronPageInspection,
  ElectronTargetList,
  InspectElectronPageInput,
  ListElectronTargetsInput,
} from "../domain/electronObservation.js";

type ElectronOperation = "list_electron_targets" | "inspect_electron_page";

/** Create Evidence v2 for one root-confined Electron observation. */
export const createElectronEvidence = (
  operation: ElectronOperation,
  input: ListElectronTargetsInput | InspectElectronPageInput,
  result: ElectronTargetList | ElectronPageInspection,
  provider: ProviderIdentity,
): Evidence =>
  createEvidence(undefined, provider, {
    predicateType:
      operation === "list_electron_targets"
        ? "rea.electron-target-list/v1"
        : "rea.electron-page-inspection/v1",
    operation,
    parameters: parameters(input),
    result: jsonValueSchema.parse(result),
    confidence: "observed",
    authority: "external-service",
    environment:
      "target" in result
        ? {
            id: `${result.browser.product}@${result.browser.revision}`,
            platform: process.platform,
            architecture: process.arch,
            isolation: "none",
          }
        : null,
    limitations: result.limitations,
  });

const parameters = (
  input: ListElectronTargetsInput | InspectElectronPageInput,
): EvidenceObservation["parameters"] => ({
  cdp_endpoint: input.cdp_endpoint,
  allowed_file_roots: input.allowed_file_roots,
  ...("target_id" in input
    ? {
        target_id: input.target_id,
        observation_ms: input.observation_ms,
        include_script_sources: input.include_script_sources,
        source_capture_approved: input.source_capture_approved,
        limits: input.limits,
      }
    : { offset: input.offset, limit: input.limit }),
});
