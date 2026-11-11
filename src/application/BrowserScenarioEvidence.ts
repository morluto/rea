import { isDeepStrictEqual } from "node:util";
import { digestCanonicalValue } from "../domain/canonicalDigest.js";
import type { ProviderIdentity } from "./AnalysisProvider.js";
import type { BrowserScenario } from "../domain/browserScenario.js";
import type { BrowserScenarioCapture } from "../domain/browserScenarioCapture.js";
import {
  createEvidence,
  type Evidence,
  type EvidenceObservation,
} from "../domain/evidence.js";
import { jsonObjectSchema, type JsonValue } from "../domain/jsonValue.js";

/** The own JSON capture and the facts admitted by its named output contract. */
export interface BrowserScenarioEvidenceReport {
  readonly source: JsonValue;
  readonly facts: BrowserScenarioCapture;
}

const browserScenarioParameters = (
  scenario: BrowserScenario,
): EvidenceObservation["parameters"] => {
  return {
    ...jsonObjectSchema.parse(scenario),
    scenario_sha256: digestCanonicalValue(scenario, "Browser scenario"),
  };
};

/** Create Evidence without retaining resolved scenario secret values. */
export const createBrowserScenarioEvidence = (
  scenario: BrowserScenario,
  report: BrowserScenarioEvidenceReport,
  provider: ProviderIdentity,
): Evidence => {
  const capture = report.facts;
  return createEvidence(undefined, provider, {
    predicateType: "rea.browser-scenario-capture",
    operation: "capture_browser_scenario",
    parameters: browserScenarioParameters(scenario),
    result: capture,
    rawResult: isDeepStrictEqual(report.source, capture) ? null : report.source,
    confidence: "observed",
    authority: "controlled-replay",
    environment: {
      id: `${capture.browser.product}@${capture.browser.version}`,
      platform: "unknown",
      architecture: "unknown",
      isolation:
        capture.browser.process_ownership === "provider-owned"
          ? "process"
          : "none",
    },
    limitations: [
      ...capture.limitations,
      "Browser host platform and architecture were not observed.",
    ],
  });
};
