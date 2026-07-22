import { z } from "zod";

import type { ProcessCapture } from "./processCapture.js";
import { validateProcessCapture } from "./processCapture.js";
import { jsonValueSchema } from "./jsonValue.js";

/** Comparison classification that never equates incomplete evidence. */
export const comparisonStatusSchema = z.enum([
  "unchanged",
  "added",
  "removed",
  "changed",
  "truncated",
  "unknown",
  "contradiction",
]);
type ComparisonStatus = z.infer<typeof comparisonStatusSchema>;

/** Canonical ordered dimensions that contribute to an overall process status. */
export const PROCESS_COMPARISON_DIMENSIONS = [
  "terminal",
  "interaction",
  "exit",
  "filesystem",
  "protocol",
  "process",
  "shim",
] as const;

/** Derive the overall comparison status from every process dimension. */
export const deriveProcessComparisonStatus = (
  dimensions: readonly ComparisonStatus[],
): ComparisonStatus => {
  if (dimensions.includes("truncated")) return "truncated";
  if (
    dimensions.some((status) =>
      ["changed", "added", "removed"].includes(status),
    )
  )
    return "changed";
  return dimensions.includes("unknown") ? "unknown" : "unchanged";
};

/** Pure normalized comparison between two captures. */
export const processCaptureComparisonSchema = z
  .object({
    status: comparisonStatusSchema,
    terminal: comparisonStatusSchema,
    interaction: comparisonStatusSchema,
    exit: comparisonStatusSchema,
    filesystem: comparisonStatusSchema,
    protocol: comparisonStatusSchema,
    process: comparisonStatusSchema,
    shim: comparisonStatusSchema,
    first_divergence: z.discriminatedUnion("status", [
      z.object({ status: z.literal("none") }),
      z.object({ status: z.literal("unknown"), reason: z.string() }),
      z.object({
        status: z.literal("found"),
        dimension: z.enum([
          "terminal",
          "interaction",
          "exit",
          "filesystem",
          "protocol",
          "process",
          "shim",
        ]),
        index: z.number().int().nonnegative(),
        left_at_ms: z.number().int().nonnegative().nullable(),
        right_at_ms: z.number().int().nonnegative().nullable(),
        left: jsonValueSchema.nullable(),
        right: jsonValueSchema.nullable(),
      }),
    ]),
    limitations: z.array(z.string()),
  })
  .superRefine((comparison, context) => {
    const expected = deriveProcessComparisonStatus(
      PROCESS_COMPARISON_DIMENSIONS.map((dimension) => comparison[dimension]),
    );
    if (comparison.status !== expected)
      context.addIssue({
        code: "custom",
        message: "Process comparison status contradicts its dimensions",
        path: ["status"],
      });
  });
export type ProcessCaptureComparison = z.infer<
  typeof processCaptureComparisonSchema
>;

const terminalObservations = (capture: ProcessCapture): readonly unknown[] =>
  [
    ...capture.frames.map((frame) => ({ kind: "raw" as const, ...frame })),
    ...capture.rendered_frames.map((frame) => ({
      kind: "rendered" as const,
      ...frame,
    })),
  ].sort((left, right) => {
    const time = left.at_ms - right.at_ms;
    if (time !== 0) return time;
    if (left.kind !== right.kind) return left.kind === "raw" ? -1 : 1;
    return left.sequence - right.sequence;
  });

const filesystemObservations = (
  capture: ProcessCapture,
): readonly unknown[] => [
  ...capture.filesystem_checkpoints,
  {
    name: "final",
    files: capture.files_after,
    effects: capture.filesystem_effects,
  },
];

/** Canonical observations for one process-comparison dimension. */
export const processDimensionObservations = (
  capture: ProcessCapture,
  dimension: (typeof PROCESS_COMPARISON_DIMENSIONS)[number],
): readonly unknown[] => {
  switch (dimension) {
    case "terminal":
      return terminalObservations(capture);
    case "interaction":
      return capture.interaction_events;
    case "exit":
      return [{ ...capture.exit, settlement: capture.settlement }];
    case "filesystem":
      return filesystemObservations(capture);
    case "protocol":
      return [...capture.protocol_events, ...capture.replay_transitions];
    case "process":
      return capture.process_samples;
    case "shim":
      return capture.shim_events;
  }
};

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

type DivergenceDimension = Exclude<
  ProcessCaptureComparison["first_divergence"],
  { readonly status: "none" | "unknown" }
>["dimension"];

const eventTime = (value: unknown): number | null => {
  if (
    typeof value === "object" &&
    value !== null &&
    "at_ms" in value &&
    typeof value.at_ms === "number" &&
    Number.isSafeInteger(value.at_ms) &&
    value.at_ms >= 0
  )
    return value.at_ms;
  return null;
};

const firstCollectionDivergence = (
  dimension: DivergenceDimension,
  left: readonly unknown[],
  right: readonly unknown[],
): Extract<
  ProcessCaptureComparison["first_divergence"],
  { readonly status: "found" }
> | null => {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = left[index] ?? null;
    const rightValue = right[index] ?? null;
    if (JSON.stringify(leftValue) === JSON.stringify(rightValue)) continue;
    return {
      status: "found",
      dimension,
      index,
      left_at_ms: eventTime(leftValue),
      right_at_ms: eventTime(rightValue),
      left: jsonValueSchema.parse(leftValue),
      right: jsonValueSchema.parse(rightValue),
    };
  }
  return null;
};

const chooseFirstDivergence = (
  candidates: ReadonlyArray<Extract<
    ProcessCaptureComparison["first_divergence"],
    { readonly status: "found" }
  > | null>,
): ProcessCaptureComparison["first_divergence"] => {
  const found = candidates.filter(
    (candidate): candidate is NonNullable<typeof candidate> =>
      candidate !== null,
  );
  return (
    found.sort((left, right) => {
      const leftTime = Math.min(
        left.left_at_ms ?? Number.MAX_SAFE_INTEGER,
        left.right_at_ms ?? Number.MAX_SAFE_INTEGER,
      );
      const rightTime = Math.min(
        right.left_at_ms ?? Number.MAX_SAFE_INTEGER,
        right.right_at_ms ?? Number.MAX_SAFE_INTEGER,
      );
      return leftTime - rightTime;
    })[0] ?? { status: "none" }
  );
};

const assertComparable = (
  left: ProcessCapture,
  right: ProcessCapture,
  options: { readonly maxCaptureAgeMs?: number; readonly now?: () => number },
): void => {
  const invalid = [
    ...validateProcessCapture(left),
    ...validateProcessCapture(right),
  ];
  if (invalid.length > 0)
    throw new TypeError(`Invalid Process Capture v4: ${invalid[0]!.path}`);
  if (
    left.schema_version !== right.schema_version ||
    left.manifest.comparison_contract_sha256 !==
      right.manifest.comparison_contract_sha256
  )
    throw new TypeError(
      "Process captures have incompatible comparison contracts",
    );
  if (options.maxCaptureAgeMs === undefined) return;
  const maxCaptureAgeMs = options.maxCaptureAgeMs;
  const now = (options.now ?? Date.now)();
  if (
    [left, right].some(
      ({ manifest }) =>
        now - Date.parse(manifest.completed_at) > maxCaptureAgeMs,
    )
  )
    throw new TypeError("Process capture exceeds max_capture_age_ms");
};

const truncatedComparison = (): ProcessCaptureComparison => ({
  status: "truncated",
  terminal: "truncated",
  interaction: "truncated",
  exit: "truncated",
  filesystem: "truncated",
  protocol: "truncated",
  process: "truncated",
  shim: "truncated",
  first_divergence: {
    status: "unknown",
    reason: "At least one capture is truncated.",
  },
  limitations: ["At least one capture is truncated."],
});

type ComparisonDimensions = Pick<
  ProcessCaptureComparison,
  | "terminal"
  | "interaction"
  | "exit"
  | "filesystem"
  | "protocol"
  | "process"
  | "shim"
>;

const compareDimensions = (
  left: ProcessCapture,
  right: ProcessCapture,
  sameNormalization: boolean,
): ComparisonDimensions => {
  const classify = (
    scope: ProcessCapture["residual_unknowns"][number]["scope"],
    leftValues: readonly unknown[],
    rightValues: readonly unknown[],
  ): ComparisonStatus =>
    !sameNormalization || hasUnknown(left, scope) || hasUnknown(right, scope)
      ? "unknown"
      : classifyCollection(leftValues, rightValues);
  return {
    terminal: classify(
      "terminal",
      terminalObservations(left),
      terminalObservations(right),
    ),
    interaction: classify(
      "interaction",
      left.interaction_events,
      right.interaction_events,
    ),
    exit:
      hasUnknown(left, "exit") || hasUnknown(right, "exit")
        ? "unknown"
        : JSON.stringify({ exit: left.exit, settlement: left.settlement }) ===
            JSON.stringify({ exit: right.exit, settlement: right.settlement })
          ? "unchanged"
          : "changed",
    filesystem: classify(
      "filesystem",
      filesystemObservations(left),
      filesystemObservations(right),
    ),
    protocol: classify(
      "protocol",
      [...left.protocol_events, ...left.replay_transitions],
      [...right.protocol_events, ...right.replay_transitions],
    ),
    process: classify("process", left.process_samples, right.process_samples),
    shim: classify("shim", left.shim_events, right.shim_events),
  };
};

/** Compare bounded captures without equating missing or incompatible evidence. */
/**
 * Compare two Process Capture v4 observations without treating absence as proof.
 *
 * Observed differences outrank residual unknowns. A capture may therefore be
 * definitively changed in one dimension while completeness remains unknown.
 */
export const compareProcessCaptures = (
  left: ProcessCapture,
  right: ProcessCapture,
  options: {
    readonly maxCaptureAgeMs?: number;
    readonly now?: () => number;
  } = {},
): ProcessCaptureComparison => {
  assertComparable(left, right, options);
  if (left.truncated || right.truncated) return truncatedComparison();
  const sameNormalization =
    JSON.stringify(left.normalization) === JSON.stringify(right.normalization);
  const dimensions = compareDimensions(left, right, sameNormalization);
  const observedFirstDivergence = chooseFirstDivergence([
    firstCollectionDivergence(
      "terminal",
      terminalObservations(left),
      terminalObservations(right),
    ),
    firstCollectionDivergence(
      "interaction",
      left.interaction_events,
      right.interaction_events,
    ),
    firstCollectionDivergence(
      "exit",
      [{ ...left.exit, settlement: left.settlement }],
      [{ ...right.exit, settlement: right.settlement }],
    ),
    firstCollectionDivergence(
      "filesystem",
      filesystemObservations(left),
      filesystemObservations(right),
    ),
    firstCollectionDivergence(
      "protocol",
      [...left.protocol_events, ...left.replay_transitions],
      [...right.protocol_events, ...right.replay_transitions],
    ),
    firstCollectionDivergence(
      "process",
      left.process_samples,
      right.process_samples,
    ),
    firstCollectionDivergence("shim", left.shim_events, right.shim_events),
  ]);
  const firstDivergence =
    observedFirstDivergence.status === "found"
      ? observedFirstDivergence
      : !sameNormalization ||
          left.residual_unknowns.length > 0 ||
          right.residual_unknowns.length > 0
        ? ({
            status: "unknown",
            reason:
              "Residual unknowns prevent proving that no divergence occurred.",
          } as const)
        : observedFirstDivergence;
  return {
    status: deriveProcessComparisonStatus(
      PROCESS_COMPARISON_DIMENSIONS.map((dimension) => dimensions[dimension]),
    ),
    ...dimensions,
    first_divergence: firstDivergence,
    limitations: [
      ...left.limitations,
      ...right.limitations,
      ...left.residual_unknowns.map(({ reason }) => reason),
      ...right.residual_unknowns.map(({ reason }) => reason),
      ...(sameNormalization ? [] : ["Capture normalization rules differ."]),
    ],
  };
};
