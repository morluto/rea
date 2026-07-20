import type { JsonValue } from "../domain/jsonValue.js";
import { createEvidence } from "../domain/evidence.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import type {
  ProcessCapture,
  ProcessScenario,
} from "../domain/processCapture.js";
import { parseProcessCapture } from "../domain/processCapture.js";

/** Provider identity for controlled Process Capture v4 evidence. */
export const PROCESS_PROVIDER = {
  id: "rea-process",
  name: "REA deterministic process harness",
  version: "4",
} as const;

/** Project one process scenario into secret-free Evidence parameters. */
const processEvidenceParameters = (
  scenario: ProcessScenario,
): Readonly<Record<string, JsonValue>> => ({
  executable_name: scenario.executable.split("/").at(-1) ?? scenario.executable,
  argument_count: scenario.arguments.length,
  event_count: scenario.events.length,
  filesystem_root_count: scenario.filesystem_roots.length,
  checkpoint_count: scenario.checkpoints.length,
  command_shim_count: scenario.command_shims.length,
  normalization: scenario.normalization,
});

/** Create one canonical observed Process Capture v4 Evidence record. */
export const createProcessCaptureEvidence = (
  scenario: ProcessScenario,
  capture: ProcessCapture,
) => {
  const validatedCapture = parseProcessCapture(capture);
  return createEvidence(undefined, PROCESS_PROVIDER, {
    predicateType: "rea.process-capture/v4",
    operation: "capture_process_scenario",
    parameters: processEvidenceParameters(scenario),
    result: jsonValueSchema.parse(validatedCapture),
    confidence: "observed",
    authority: "controlled-replay",
    environment: {
      id: `${process.platform}-${process.arch}`,
      platform: process.platform,
      architecture: process.arch,
      isolation: "process",
    },
    limitations: validatedCapture.limitations,
  });
};
