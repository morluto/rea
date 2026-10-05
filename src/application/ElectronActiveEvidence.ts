import type { ProviderIdentity } from "./AnalysisProvider.js";
import type { Evidence, EvidenceObservation } from "../domain/evidence.js";
import { createEvidence } from "../domain/evidence.js";
import type {
  ElectronActiveObservationInput,
  ElectronActiveObservationResult,
} from "../domain/electronActiveObservation.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import { digestCanonicalJson } from "../domain/browserScenarioNormalization.js";

type CanonicalElectronActiveObservationInput =
  ElectronActiveObservationInput & {
    readonly application_root: string;
  };

/** Create Evidence without retaining arbitrary runtime argument values. */
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
      id: `${result.application.electron_version}@${process.platform}`,
      platform: process.platform,
      architecture: process.arch,
      isolation: "none",
    },
    limitations: result.limitations,
  });

const scenarioProjection = (
  input: CanonicalElectronActiveObservationInput,
): EvidenceObservation["parameters"] => ({
  executable_path: input.executable_path,
  application_path: input.application_path,
  application_root: input.application_root,
  args: [...input.args],
  actions: input.actions.map(({ step_id, kind }) => ({ step_id, kind })),
});

const parameters = (
  input: CanonicalElectronActiveObservationInput,
): EvidenceObservation["parameters"] => ({
  ...scenarioProjection(input),
  scenario_sha256: digestCanonicalJson(scenarioProjection(input)),
});
