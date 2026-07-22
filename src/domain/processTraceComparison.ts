import type { ProcessCapture } from "./processCapture.js";
import { validateProcessCapture } from "./processCaptureValidation.js";
import {
  evaluateProcessTraceSide,
  processTraceComparisonResultSchema,
  type ProcessTraceComparisonResult,
} from "./processTraceEvaluation.js";
import {
  processTraceSpecificationSchema,
  type ProcessTraceSpecification,
} from "./processTraceSpecification.js";

export {
  processTraceComparisonResultSchema,
  type ProcessTraceComparisonResult,
  type ProcessTraceLocation,
} from "./processTraceEvaluation.js";
export {
  processTraceSourceSchema,
  processTraceSpecificationSchema,
  type ProcessTraceSource,
  type ProcessTraceSpecification,
} from "./processTraceSpecification.js";

/** Compare two captures against an explicit finite trace language. */
export const compareProcessTraces = (
  left: ProcessCapture,
  right: ProcessCapture,
  specificationInput: ProcessTraceSpecification,
): ProcessTraceComparisonResult => {
  const captureIssues = [
    ...validateProcessCapture(left),
    ...validateProcessCapture(right),
  ];
  if (captureIssues.length > 0)
    throw new TypeError(
      `Invalid Process Capture v4: ${captureIssues[0]!.path}`,
    );
  const specification =
    processTraceSpecificationSchema.parse(specificationInput);
  const leftEvaluation = evaluateProcessTraceSide(left, specification);
  const rightEvaluation = evaluateProcessTraceSide(right, specification);
  const diagnostic =
    leftEvaluation.diagnostic === null
      ? rightEvaluation.diagnostic === null
        ? null
        : { side: "right" as const, ...rightEvaluation.diagnostic }
      : { side: "left" as const, ...leftEvaluation.diagnostic };
  const outcomesDiffer =
    leftEvaluation.result.status !== rightEvaluation.result.status ||
    JSON.stringify(
      leftEvaluation.result.raw_trace.map(({ event_id }) => event_id),
    ) !==
      JSON.stringify(
        rightEvaluation.result.raw_trace.map(({ event_id }) => event_id),
      );
  return processTraceComparisonResultSchema.parse({
    verdict:
      leftEvaluation.result.status === "unknown" ||
      rightEvaluation.result.status === "unknown"
        ? "unknown"
        : leftEvaluation.result.status === "pass" &&
            rightEvaluation.result.status === "pass"
          ? "equivalent"
          : outcomesDiffer
            ? "different"
            : "nonconforming",
    left: leftEvaluation.result,
    right: rightEvaluation.result,
    diagnostic,
  });
};

/** Whether trace conformance or raw declared order differs across captures. */
export const processTraceOutcomesDiffer = (
  comparison: ProcessTraceComparisonResult,
): boolean =>
  comparison.left.status !== comparison.right.status ||
  JSON.stringify(comparison.left.raw_trace.map(({ event_id }) => event_id)) !==
    JSON.stringify(comparison.right.raw_trace.map(({ event_id }) => event_id));
