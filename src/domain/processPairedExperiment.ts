import { z } from "zod";

import type { ProcessCapture } from "./processCapture.js";
import {
  PROCESS_COMPARISON_DIMENSIONS,
  compareProcessCaptures,
  processDimensionObservations,
  type ProcessCaptureComparison,
} from "./processComparison.js";
import {
  digestProcessCommitment,
  processScenarioSchema,
  type ProcessScenario,
} from "./processScenario.js";

const sideIdentifierSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9._-]{0,127}$/u);
const environmentNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u);
const processDimensionSchema = z.enum(PROCESS_COMPARISON_DIMENSIONS);

const sideBindingSchema = z
  .object({
    id: sideIdentifierSchema,
    executable: z.string().startsWith("/"),
    arguments: z.array(z.string()).max(256).optional(),
    environment: z.record(environmentNameSchema, z.string()).default({}),
  })
  .strict();

/** Boundary contract for one bounded authority/candidate process experiment. */
export const processPairedExperimentSchema = z
  .object({
    approved: z.literal(true),
    shared_scenario: processScenarioSchema,
    authority: sideBindingSchema,
    candidate: sideBindingSchema,
    repeat_count: z.number().int().min(2).max(10).default(3),
    freshness_policy: z
      .object({
        max_capture_age_ms: z.number().int().positive().max(86_400_000),
      })
      .strict(),
    required_dimensions: z
      .array(processDimensionSchema)
      .min(1)
      .max(PROCESS_COMPARISON_DIMENSIONS.length)
      .default([...PROCESS_COMPARISON_DIMENSIONS]),
    reconstruction_claims: z
      .array(
        z
          .object({
            id: sideIdentifierSchema,
            predicate: z.string().min(1).max(256),
          })
          .strict(),
      )
      .max(64)
      .default([]),
  })
  .strict()
  .superRefine((experiment, context) => {
    if (experiment.authority.id === experiment.candidate.id)
      context.addIssue({
        code: "custom",
        message: "authority and candidate identities must differ",
        path: ["candidate", "id"],
      });
    if (
      new Set(experiment.required_dimensions).size !==
      experiment.required_dimensions.length
    )
      context.addIssue({
        code: "custom",
        message: "required process dimensions must be unique",
        path: ["required_dimensions"],
      });
  });

export type ProcessPairedExperiment = z.infer<
  typeof processPairedExperimentSchema
>;
export type ProcessSideBinding = ProcessPairedExperiment[
  | "authority"
  | "candidate"];

type ProcessRepeatabilityClassification =
  | "stable"
  | "timing_variance"
  | "nondeterministic_output"
  | "flaky_exit"
  | "environmental_drift"
  | "insufficient_samples";

export interface ProcessSideRepeatability {
  readonly classification: ProcessRepeatabilityClassification;
  readonly stable: boolean;
  readonly digest: string;
  readonly comparisons: readonly ProcessCaptureComparison[];
  readonly unstable_dimensions: readonly (typeof PROCESS_COMPARISON_DIMENSIONS)[number][];
}

/** Apply a side binding without changing the shared observation contract. */
export const bindProcessScenario = (
  shared: ProcessScenario,
  side: ProcessSideBinding,
): ProcessScenario =>
  processScenarioSchema.parse({
    ...shared,
    executable: side.executable,
    arguments: side.arguments ?? shared.arguments,
    environment: { ...shared.environment, ...side.environment },
  });

const classifyInstability = (
  dimensions: ReadonlySet<(typeof PROCESS_COMPARISON_DIMENSIONS)[number]>,
): ProcessRepeatabilityClassification => {
  if (dimensions.has("exit")) return "flaky_exit";
  if (dimensions.has("filesystem") || dimensions.has("process"))
    return "environmental_drift";
  return "nondeterministic_output";
};

const timingKeys = new Set([
  "at_ms",
  "scheduled_at_ms",
  "dispatched_at_ms",
  "elapsed_ms",
]);

const withoutTiming = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutTiming);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !timingKeys.has(key))
      .map(([key, entry]) => [key, withoutTiming(entry)]),
  );
};

const hasOnlyTimingVariance = (
  captures: readonly ProcessCapture[],
  dimensions: readonly (typeof PROCESS_COMPARISON_DIMENSIONS)[number][],
): boolean =>
  dimensions.every((dimension) => {
    const baseline = JSON.stringify(
      withoutTiming(processDimensionObservations(captures[0]!, dimension)),
    );
    return captures
      .slice(1)
      .every(
        (capture) =>
          JSON.stringify(
            withoutTiming(processDimensionObservations(capture, dimension)),
          ) === baseline,
      );
  });

/** Compare same-side repeats before permitting a cross-side claim. */
export const analyzeProcessRepeatability = (
  captures: readonly ProcessCapture[],
  requiredDimensions: readonly (typeof PROCESS_COMPARISON_DIMENSIONS)[number][],
): ProcessSideRepeatability => {
  if (captures.length < 2)
    return {
      classification: "insufficient_samples",
      stable: false,
      digest: digestProcessCommitment({ captures: [], requiredDimensions }),
      comparisons: [],
      unstable_dimensions: [],
    };
  const comparisons = captures
    .slice(1)
    .map((capture, index) => compareProcessCaptures(captures[index]!, capture));
  const unstable = new Set(
    requiredDimensions.filter((dimension) =>
      comparisons.some((comparison) => comparison[dimension] !== "unchanged"),
    ),
  );
  const unstableDimensions = PROCESS_COMPARISON_DIMENSIONS.filter((dimension) =>
    unstable.has(dimension),
  );
  return {
    classification:
      unstable.size === 0
        ? "stable"
        : hasOnlyTimingVariance(captures, unstableDimensions)
          ? "timing_variance"
          : classifyInstability(unstable),
    stable: unstable.size === 0,
    digest: digestProcessCommitment({
      requiredDimensions,
      comparisons,
    }),
    comparisons,
    unstable_dimensions: unstableDimensions,
  };
};
