import { compareFunctions } from "../domain/functionComparison.js";
import { createEvidence } from "../domain/evidence.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import { createEvidenceBundle } from "../domain/evidenceBundle.js";
import {
  compareProcessCaptures,
  processCaptureSchema,
} from "../domain/processCapture.js";
import { FUNCTION_COMPARISON_EXAMPLE } from "./functionComparisonExample.js";
import { EMPTY_PROCESS_CAPTURE_EXAMPLE } from "./processCaptureExample.js";

const comparison = compareFunctions(
  FUNCTION_COMPARISON_EXAMPLE.left,
  FUNCTION_COMPARISON_EXAMPLE.right,
  0,
  100,
);

export const FUNCTION_COMPARISON_EVIDENCE = createEvidence(
  undefined,
  {
    id: "rea-function-comparison",
    name: "REA function comparison",
    version: "1",
  },
  {
    predicateType: "rea.function-comparison/v1",
    operation: "compare_functions",
    parameters: {
      left_evidence_ids: [FUNCTION_COMPARISON_EXAMPLE.left.evidence_id],
      right_evidence_ids: [FUNCTION_COMPARISON_EXAMPLE.right.evidence_id],
      offset: 0,
      limit: 100,
    },
    result: jsonValueSchema.parse(comparison),
    confidence: "derived",
    authority: "analyst-inference",
    evidenceLinks: [
      FUNCTION_COMPARISON_EXAMPLE.left.evidence_id,
      FUNCTION_COMPARISON_EXAMPLE.right.evidence_id,
    ],
  },
);

const PROCESS_PROVIDER = {
  id: "rea-process",
  name: "REA deterministic process harness",
  version: "3",
} as const;
const capture = processCaptureSchema.parse(EMPTY_PROCESS_CAPTURE_EXAMPLE);
const captureEvidence = (scenario: string) =>
  createEvidence(undefined, PROCESS_PROVIDER, {
    predicateType: "rea.process-capture/v4",
    operation: "capture_process_scenario",
    parameters: { scenario },
    result: jsonValueSchema.parse(capture),
    confidence: "observed",
    authority: "controlled-replay",
    environment: {
      id: "fixture-linux",
      platform: "linux",
      architecture: "x86_64",
      isolation: "container",
    },
  });
export const PROCESS_CAPTURE_REFERENCE = captureEvidence("reference");
export const PROCESS_CAPTURE_RECONSTRUCTION = captureEvidence("reconstruction");
export const PROCESS_COMPARISON_EVIDENCE = createEvidence(
  undefined,
  PROCESS_PROVIDER,
  {
    predicateType: "rea.process-comparison/v3",
    operation: "compare_process_captures",
    parameters: {
      left_evidence_id: PROCESS_CAPTURE_REFERENCE.evidence_id,
      right_evidence_id: PROCESS_CAPTURE_RECONSTRUCTION.evidence_id,
      left_normalization: capture.normalization,
      right_normalization: capture.normalization,
    },
    result: jsonValueSchema.parse(compareProcessCaptures(capture, capture)),
    confidence: "derived",
    authority: "analyst-inference",
    evidenceLinks: [
      PROCESS_CAPTURE_REFERENCE.evidence_id,
      PROCESS_CAPTURE_RECONSTRUCTION.evidence_id,
    ],
  },
);

/** Canonical inputs for comparison-composed investigation contracts. */
export const INVESTIGATION_EXAMPLES = {
  find_changed_behavior: { comparisons: [FUNCTION_COMPARISON_EVIDENCE] },
  build_call_path: {
    functions: [FUNCTION_COMPARISON_EXAMPLE.left],
    start: { address: "0x1000" },
    goal: { address: "0x1000" },
  },
  correlate_static_and_runtime: {
    static_comparisons: [FUNCTION_COMPARISON_EVIDENCE],
    runtime_comparisons: [PROCESS_COMPARISON_EVIDENCE],
    mappings: [
      {
        static: {
          comparison_evidence_id: FUNCTION_COMPARISON_EVIDENCE.evidence_id,
          selector: { kind: "function", dimension: "pseudocode" },
        },
        runtime: {
          comparison_evidence_id: PROCESS_COMPARISON_EVIDENCE.evidence_id,
          dimension: "terminal",
        },
        side_alignment: "left_to_left",
        hypothesis: {
          statement: "Static implementation changed without terminal change.",
          expected_pattern: "static_only",
        },
      },
    ],
  },
  verify_reconstruction: {
    specification: {
      schema_version: 1,
      name: "Terminal compatibility",
      claims: [
        {
          kind: "behavioral",
          claim_id: "terminal-output",
          title: "Terminal output remains equivalent",
          comparison_evidence_id: PROCESS_COMPARISON_EVIDENCE.evidence_id,
          dimension: "terminal",
        },
      ],
    },
    evidence_bundle: createEvidenceBundle([
      PROCESS_CAPTURE_REFERENCE,
      PROCESS_CAPTURE_RECONSTRUCTION,
      PROCESS_COMPARISON_EVIDENCE,
    ]),
  },
};
