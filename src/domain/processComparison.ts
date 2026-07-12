import { z } from "zod";

import type { ProcessCapture } from "./processCapture.js";

/** Comparison classification that never equates incomplete evidence. */
export const comparisonStatusSchema = z.enum([
  "unchanged",
  "added",
  "removed",
  "changed",
  "truncated",
  "unknown",
]);
type ComparisonStatus = z.infer<typeof comparisonStatusSchema>;

/** Pure normalized comparison between two captures. */
export const processCaptureComparisonSchema = z
  .object({
    status: comparisonStatusSchema,
    terminal: comparisonStatusSchema,
    exit: comparisonStatusSchema,
    filesystem: comparisonStatusSchema,
    protocol: comparisonStatusSchema,
    process: comparisonStatusSchema,
    limitations: z.array(z.string()),
  })
  .superRefine((comparison, context) => {
    const dimensions = [
      comparison.terminal,
      comparison.exit,
      comparison.filesystem,
      comparison.protocol,
      comparison.process,
    ];
    const expected = dimensions.includes("truncated")
      ? "truncated"
      : dimensions.some((status) =>
            ["added", "removed", "changed"].includes(status),
          )
        ? "changed"
        : dimensions.includes("unknown")
          ? "unknown"
          : "unchanged";
    if (comparison.status !== expected)
      context.addIssue({
        code: "custom",
        message: "Process comparison status contradicts its dimensions",
        path: ["status"],
      });
  });
type ProcessCaptureComparison = z.infer<typeof processCaptureComparisonSchema>;

const stableFiles = (capture: ProcessCapture): string =>
  JSON.stringify(
    [...capture.files_after].sort((left, right) =>
      left.path.localeCompare(right.path),
    ),
  );

const classifyCollection = (
  left: readonly unknown[],
  right: readonly unknown[],
): ComparisonStatus => {
  if (JSON.stringify(left) === JSON.stringify(right)) return "unchanged";
  if (left.length === 0) return "added";
  if (right.length === 0) return "removed";
  return "changed";
};

const hasUnknown = (
  capture: ProcessCapture,
  scope: ProcessCapture["residual_unknowns"][number]["scope"],
): boolean => capture.residual_unknowns.some((item) => item.scope === scope);

const comparisonStatus = (
  dimensions: readonly ComparisonStatus[],
): ComparisonStatus => {
  if (
    dimensions.some((status) =>
      ["changed", "added", "removed"].includes(status),
    )
  )
    return "changed";
  return dimensions.includes("unknown") ? "unknown" : "unchanged";
};

/** Compare bounded captures without equating missing or incompatible evidence. */
export const compareProcessCaptures = (
  left: ProcessCapture,
  right: ProcessCapture,
): ProcessCaptureComparison => {
  if (left.truncated || right.truncated) {
    return {
      status: "truncated",
      terminal: "truncated",
      exit: "truncated",
      filesystem: "truncated",
      protocol: "truncated",
      process: "truncated",
      limitations: ["At least one capture is truncated."],
    };
  }
  const sameNormalization =
    JSON.stringify(left.normalization) === JSON.stringify(right.normalization);
  const classify = (
    scope: ProcessCapture["residual_unknowns"][number]["scope"],
    leftValues: readonly unknown[],
    rightValues: readonly unknown[],
  ): ComparisonStatus =>
    !sameNormalization || hasUnknown(left, scope) || hasUnknown(right, scope)
      ? "unknown"
      : classifyCollection(leftValues, rightValues);
  const terminal = classify(
    "terminal",
    left.frames.map(({ data }) => data),
    right.frames.map(({ data }) => data),
  );
  const exit =
    hasUnknown(left, "exit") || hasUnknown(right, "exit")
      ? "unknown"
      : JSON.stringify(left.exit) === JSON.stringify(right.exit)
        ? "unchanged"
        : "changed";
  const filesystem =
    !hasUnknown(left, "filesystem") &&
    !hasUnknown(right, "filesystem") &&
    sameNormalization &&
    stableFiles(left) === stableFiles(right)
      ? "unchanged"
      : classify(
          "filesystem",
          left.filesystem_effects,
          right.filesystem_effects,
        );
  const protocol = classify(
    "protocol",
    left.protocol_events,
    right.protocol_events,
  );
  const process = classify(
    "process",
    left.process_samples,
    right.process_samples,
  );
  return {
    status: comparisonStatus([terminal, exit, filesystem, protocol, process]),
    terminal,
    exit,
    filesystem,
    protocol,
    process,
    limitations: [
      ...left.limitations,
      ...right.limitations,
      ...left.residual_unknowns.map(({ reason }) => reason),
      ...right.residual_unknowns.map(({ reason }) => reason),
      ...(sameNormalization ? [] : ["Capture normalization rules differ."]),
    ],
  };
};
