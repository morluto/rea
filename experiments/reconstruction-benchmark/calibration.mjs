import { createEvidence } from "../../dist/domain/evidence.js";
import { PROCESS_PROVIDER } from "../../dist/domain/process/processEvidenceProvider.js";
import { EMPTY_PROCESS_CAPTURE_EXAMPLE } from "../../dist/domain/process/processCaptureExample.js";

export const EXPECTED_OUTCOMES = Object.freeze({
  "equal-complete": "pass",
  "changed-exit": "fail",
  "unknown-environment": "unknown",
});

// Deliberately synthetic records using REA's existing contract example.
// The inner authority fields exercise the protocol; they are NOT real observations.
function capture(side, { unknown = false, exitCode = 0 } = {}) {
  return createEvidence(undefined, PROCESS_PROVIDER, {
    predicateType: "rea.process-capture",
    operation: "capture_process_scenario",
    parameters: { side },
    result: {
      ...EMPTY_PROCESS_CAPTURE_EXAMPLE,
      exit: { ...EMPTY_PROCESS_CAPTURE_EXAMPLE.exit, code: exitCode },
      residual_unknowns: unknown
        ? [
            {
              scope: "environment",
              reason:
                "Synthetic calibration leaves environment authority unknown.",
            },
          ]
        : [],
    },
    confidence: "observed",
    authority: "controlled-replay",
    environment: {
      id: "synthetic-calibration",
      platform: "fixture",
      architecture: "fixture",
      isolation: "process",
    },
  });
}

export function calibrationPack() {
  return {
    format: "rea-reconstruction-calibration/v1",
    tasks: [
      ["equal-complete", {}, {}],
      ["changed-exit", {}, { exitCode: 1 }],
      ["unknown-environment", { unknown: true }, { unknown: true }],
    ].map(([id, left, right]) => ({
      id,
      comparison: {
        operation: "compare_process_captures",
        arguments: {
          left: capture("left", left),
          right: capture("right", right),
        },
      },
      claims: [
        {
          claim_id: "overall",
          title: "Declared replay behavior agrees",
          dimension: "overall",
        },
      ],
    })),
  };
}
