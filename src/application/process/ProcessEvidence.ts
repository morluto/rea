import type { JsonValue } from "../../domain/jsonValue.js";
import { createEvidence } from "../../domain/evidence.js";
import { PROCESS_PROVIDER } from "../../domain/process/processEvidenceProvider.js";
import { jsonValueSchema } from "../../domain/jsonValue.js";
import type {
  ProcessCapture,
  ProcessScenario,
} from "../../domain/process/processCapture.js";

export { PROCESS_PROVIDER } from "../../domain/process/processEvidenceProvider.js";

/** Project one process scenario into secret-free Evidence parameters. */
const processEvidenceParameters = (
  scenario: ProcessScenario,
): Readonly<Record<string, JsonValue>> => ({
  executable_name: scenario.executable.split("/").at(-1) ?? scenario.executable,
  argument_count: scenario.arguments.length,
  event_count: scenario.events.length,
  filesystem_observation_path_count:
    scenario.filesystem_observation_paths.length,
  normalization: scenario.normalization,
});

/** Create one canonical observed process capture Evidence record. */
export const createProcessCaptureEvidence = (
  scenario: ProcessScenario,
  capture: ProcessCapture,
) => {
  return createEvidence(undefined, PROCESS_PROVIDER, {
    predicateType: "rea.process-capture",
    operation: "capture_process_scenario",
    parameters: processEvidenceParameters(scenario),
    result: jsonValueSchema.parse(capture),
    confidence: "observed",
    authority: "controlled-replay",
    environment: {
      id: `${capture.manifest.platform}-${capture.manifest.architecture}`,
      platform: capture.manifest.platform,
      architecture: capture.manifest.architecture,
      isolation: "process",
    },
    limitations: capture.limitations,
  });
};
