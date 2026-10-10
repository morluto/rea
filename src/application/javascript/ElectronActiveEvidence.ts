import { digestCanonicalValue } from "../../domain/canonicalDigest.js";
import type { ProviderIdentity } from "../AnalysisProvider.js";
import type { Evidence, EvidenceObservation } from "../../domain/evidence.js";
import { createEvidence } from "../../domain/evidence.js";
import type {
  ElectronActiveObservationInput,
  ElectronActiveObservationResult,
} from "../../domain/javascript/electronActiveObservation.js";
import { jsonObjectSchema, jsonValueSchema } from "../../domain/jsonValue.js";

type CanonicalElectronActiveObservationInput =
  ElectronActiveObservationInput & {
    readonly application_root: string;
  };

/** Commit the selected Electron experiment and its observed result. */
export const createElectronActiveEvidence = (
  input: CanonicalElectronActiveObservationInput,
  result: ElectronActiveObservationResult,
  provider: ProviderIdentity,
): Evidence =>
  createEvidence(undefined, provider, {
    predicateType: "rea.electron-active-scenario",
    operation: "capture_electron_scenario",
    parameters: parameters(input),
    result: jsonValueSchema.parse(result),
    confidence: "observed",
    authority: "controlled-replay",
    environment: {
      id: `${result.application.electron_version}@unknown`,
      platform: "unknown",
      architecture: "unknown",
      isolation: "none",
    },
    limitations: [
      ...result.limitations,
      "Application host platform and architecture were not observed.",
    ],
  });

const parameters = (
  input: CanonicalElectronActiveObservationInput,
): EvidenceObservation["parameters"] => {
  const scenario = jsonObjectSchema.parse(input);
  return {
    ...scenario,
    scenario_sha256: digestCanonicalValue(scenario, "Electron scenario"),
  };
};
