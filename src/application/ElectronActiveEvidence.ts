import type { ProviderIdentity } from "./AnalysisProvider.js";
import type { Evidence, EvidenceObservation } from "../domain/evidence.js";
import { createEvidence } from "../domain/evidence.js";
import type {
  ElectronActiveObservationInput,
  ElectronActiveObservationResult,
} from "../domain/electronActiveObservation.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import { digestJson } from "./JavaScriptReplayPlanning.js";

/** Create Evidence v2 without retaining arbitrary runtime argument values. */
export const createElectronActiveEvidence = (
  input: ElectronActiveObservationInput,
  result: ElectronActiveObservationResult,
  provider: ProviderIdentity,
): Evidence =>
  createEvidence(undefined, provider, {
    predicateType: "rea.electron-active-scenario/v1",
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
  input: ElectronActiveObservationInput,
): EvidenceObservation["parameters"] => ({
  approved: input.approved,
  schema_version: input.schema_version,
  executable_path: input.executable_path,
  application_path: input.application_path,
  application_root: input.application_root,
  args: redactArguments(input.args),
  actions: input.actions.map(({ step_id, kind }) => ({ step_id, kind })),
  limits: input.limits,
});

const parameters = (
  input: ElectronActiveObservationInput,
): EvidenceObservation["parameters"] => ({
  ...scenarioProjection(input),
  scenario_sha256: digestJson(scenarioProjection(input)),
});

const redactArguments = (arguments_: readonly string[]): string[] => {
  let redactNext = false;
  return arguments_.map((argument) => {
    if (redactNext) {
      redactNext = false;
      return "<redacted>";
    }
    if (sensitiveFlag.test(argument)) {
      redactNext = true;
      return argument;
    }
    return redactArgument(argument);
  });
};

const sensitiveFlag =
  /^--?(?:password|token|secret|api[-_]?key|authorization|cookie)$/iu;

const redactArgument = (argument: string): string => {
  if (
    /^--?(?:password|token|secret|api[-_]?key|authorization|cookie)=/iu.test(
      argument,
    )
  )
    return `${argument.slice(0, argument.indexOf("=") + 1)}<redacted>`;
  return argument.length > 256
    ? `${argument.slice(0, 256)}<redacted>`
    : argument;
};
