import { readFile } from "node:fs/promises";

import { parseConfig } from "../config.js";
import { createEvidence, parseEvidence } from "../domain/evidence.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import {
  compareProcessCaptures,
  parseProcessScenario,
  processCaptureSchema,
} from "../domain/processCapture.js";
import { captureProcessScenario } from "./ProcessHarness.js";
import {
  PROCESS_PROVIDER,
  createProcessCaptureEvidence,
} from "./ProcessEvidence.js";

const MAX_INPUT_BYTES = 64 * 1024 * 1024;

/** Capture one JSON scenario through the same policy and evidence contract as MCP. */
export const captureProcessScenarioFile = async (path: string) => {
  const scenario = parseProcessScenario(await readJson(path));
  const config = parseConfig(process.env);
  if (!config.ok) throw config.error;
  const captured = await captureProcessScenario(
    scenario,
    config.value.processExecutionPolicy,
  );
  if (!captured.ok) throw captured.error;
  return createProcessCaptureEvidence(scenario, captured.value);
};

/** Compare two capture Evidence files and emit derived comparison Evidence. */
export const compareProcessEvidenceFiles = async (
  leftPath: string,
  rightPath: string,
) => {
  const left = parseCaptureEvidence(await readJson(leftPath));
  const right = parseCaptureEvidence(await readJson(rightPath));
  const comparison = compareProcessCaptures(left.capture, right.capture);
  return createEvidence(undefined, PROCESS_PROVIDER, {
    predicateType: "rea.process-comparison/v2",
    operation: "compare_process_captures",
    parameters: {
      left_evidence_id: left.id,
      right_evidence_id: right.id,
      left_normalization: left.capture.normalization,
      right_normalization: right.capture.normalization,
    },
    result: jsonValueSchema.parse(comparison),
    confidence: "derived",
    authority: "analyst-inference",
    limitations: comparison.limitations,
    evidenceLinks: [left.id, right.id],
  });
};

const parseCaptureEvidence = (input: unknown) => {
  const evidence = parseEvidence(input);
  if (
    evidence.operation !== "capture_process_scenario" ||
    evidence.predicate_type !== "rea.process-capture/v3" ||
    evidence.provider.id !== PROCESS_PROVIDER.id ||
    evidence.provider.version !== PROCESS_PROVIDER.version
  )
    throw new TypeError("Expected REA Process Capture v3 Evidence");
  return {
    id: evidence.evidence_id,
    capture: processCaptureSchema.parse(evidence.normalized_result),
  };
};

const readJson = async (path: string): Promise<unknown> => {
  const bytes = await readFile(path);
  if (bytes.length > MAX_INPUT_BYTES)
    throw new TypeError("Process JSON input exceeds byte limit");
  return JSON.parse(bytes.toString("utf8")) as unknown;
};
