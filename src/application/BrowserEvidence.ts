import type { ProviderIdentity } from "./AnalysisProvider.js";
import {
  createEvidence,
  type Evidence,
  type EvidenceObservation,
} from "../domain/evidence.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import type {
  BrowserTargetList,
  InspectWebPageInput,
  ListBrowserTargetsInput,
  WebPageInspection,
} from "../domain/browserObservation.js";

type BrowserEvidenceInput = ListBrowserTargetsInput | InspectWebPageInput;
type BrowserEvidenceResult = BrowserTargetList | WebPageInspection;

/** Create Evidence v2 for a policy-scoped external browser observation. */
export const createBrowserEvidence = (
  operation: "list_browser_targets" | "inspect_web_page",
  input: BrowserEvidenceInput,
  result: BrowserEvidenceResult,
  provider: ProviderIdentity,
): Evidence =>
  createEvidence(undefined, provider, {
    predicateType:
      operation === "list_browser_targets"
        ? "rea.browser-target-list/v1"
        : "rea.web-page-inspection/v1",
    operation,
    parameters: browserParameters(input),
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

const browserParameters = (
  input: BrowserEvidenceInput,
): EvidenceObservation["parameters"] => ({
  cdp_endpoint: input.cdp_endpoint,
  allowed_origins: input.allowed_origins,
  ...("target_id" in input
    ? {
        target_id: input.target_id,
        observation_ms: input.observation_ms,
        include_script_sources: input.include_script_sources,
        include_storage_keys: input.include_storage_keys,
        limits: input.limits,
      }
    : { offset: input.offset, limit: input.limit }),
});
