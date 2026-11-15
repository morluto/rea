import { z } from "zod";
import { EvidenceIntegrityError } from "./evidenceErrors.js";

import {
  browserCaptureComparisonSchema,
  compareBrowserCaptures,
} from "./browserCaptureComparison.js";
import type { RetainedBrowserScenarioCapture } from "./browserScenarioCapture.js";
import {
  artifactEvidenceState,
  eventEvidenceState,
} from "./browserScenarioDiffEvidence.js";
import {
  browserScenarioOriginMappingSchema,
  browserScenarioArtifactKindSchema,
  type BrowserScenarioArtifactKind,
  type BrowserScenarioDiff,
} from "./browserScenarioDiffValues.js";
import { digestCanonicalValue } from "./canonicalDigest.js";
import type { Evidence } from "./evidence.js";
import { comparePngScreenshots } from "./pngVisualDiff.js";
import type {
  ReconstructionClaim,
  ReconstructionObservedStatus,
} from "./reconstructionVerificationSchemas.js";
import {
  readWebComparisonSource,
  readWebScenarioSource,
  webCaptureComparisonPolicySchema,
  webCaptureSourceInput,
  webComparisonSourceAssessment,
  webScreenshotComparisonResultSchema,
  webScreenshotSourceArtifact,
} from "./webComparisonSources.js";
import { compareWebScreenshotsInputSchema } from "./webScreenshot.js";
import type { WebCaptureDiff } from "./webCaptureDiffSchemas.js";

export type WebReconstructionClaim = Extract<
  ReconstructionClaim,
  { kind: "web-scenario" | "web-capture" | "web-screenshot" }
>;

export interface WebReconstructionFacts {
  readonly observed: ReconstructionObservedStatus;
  readonly limitations: readonly string[];
  readonly diagnostics?: readonly string[];
  readonly accepted_visual_difference?: boolean;
  readonly measured_changed_ratio?: number;
}

/** Keep web-specific authority, source selection and acceptance in one evaluator. */
export const isWebReconstructionClaim = (
  claim: ReconstructionClaim,
): claim is WebReconstructionClaim =>
  claim.kind === "web-scenario" ||
  claim.kind === "web-capture" ||
  claim.kind === "web-screenshot";

type ScenarioStatuses = ReadonlyMap<string, ReconstructionObservedStatus>;
type PreparedWebComparison =
  | {
      readonly kind: "web-scenario";
      readonly limitations: readonly string[];
      readonly coverage: readonly string[];
      readonly steps: ReadonlyMap<string, ScenarioStatuses>;
      readonly all: ScenarioStatuses;
    }
  | {
      readonly kind: "web-capture";
      readonly limitations: readonly string[];
      readonly coverage: readonly string[];
      readonly result: WebCaptureDiff;
    }
  | {
      readonly kind: "web-screenshot";
      readonly facts: WebReconstructionFacts & {
        readonly coverage: readonly string[];
      };
    };

export type WebReconstructionEvaluator = (
  claim: WebReconstructionClaim,
  comparison: Evidence,
  sides: {
    readonly left: readonly string[];
    readonly right: readonly string[];
  },
) => WebReconstructionFacts;

/** Share authenticated derivations only within this verification request. */
export const createWebReconstructionEvaluator = (
  sources: ReadonlyMap<string, Evidence>,
): WebReconstructionEvaluator => {
  const prepared = new WeakMap<Evidence, PreparedWebComparison>();
  return (claim, comparison, sides) => {
    let facts = prepared.get(comparison);
    if (facts === undefined) {
      try {
        facts = prepareWebComparison(comparison, sources, sides);
      } catch (cause: unknown) {
        if (cause instanceof TypeError || cause instanceof z.ZodError) {
          const message =
            cause instanceof z.ZodError
              ? "Web comparison source or policy is malformed."
              : cause.message;
          throw new EvidenceIntegrityError(message, {
            cause,
            userMessage: message,
          });
        }
        throw cause;
      }
      prepared.set(comparison, facts);
    }
    if (facts.kind !== claim.kind)
      throw new EvidenceIntegrityError(
        "Web claim and comparison observation types disagree.",
      );
    if (facts.kind === "web-screenshot" && claim.kind === "web-screenshot") {
      const accepted =
        facts.facts.measured_changed_ratio !== undefined &&
        facts.facts.measured_changed_ratio <= claim.maximum_changed_ratio;
      return {
        ...facts.facts,
        ...assessCoverage(facts.facts.observed, facts.facts, accepted),
        ...(facts.facts.measured_changed_ratio === undefined
          ? {}
          : { accepted_visual_difference: accepted }),
      };
    }
    if (facts.kind === "web-capture" && claim.kind === "web-capture") {
      const observed =
        claim.dimension === "overall"
          ? facts.result.overall_status
          : facts.result.dimensions[claim.dimension].status;
      return { observed, ...assessCoverage(observed, facts) };
    }
    if (facts.kind === "web-scenario" && claim.kind === "web-scenario") {
      const selected =
        claim.step_id === undefined
          ? facts.all
          : facts.steps.get(claim.step_id);
      return selected === undefined
        ? {
            observed: "unknown",
            limitations: [
              ...facts.limitations,
              ...facts.coverage,
              "The selected scenario step has no aligned observations.",
            ],
          }
        : {
            observed: selected.get(claim.dimension) ?? "unknown",
            ...assessCoverage(
              selected.get(claim.dimension) ?? "unknown",
              facts,
            ),
          };
    }
    throw new TypeError("Unsupported web reconstruction claim.");
  };
};

/** Validate each comparison against exactly the observations committed on both sides once. */
const prepareWebComparison = (
  comparison: Evidence,
  sources: ReadonlyMap<string, Evidence>,
  sides: {
    readonly left: readonly string[];
    readonly right: readonly string[];
  },
): PreparedWebComparison => {
  if (sides.left.length !== 1 || sides.right.length !== 1)
    throw new TypeError(
      "Web comparisons require exactly one source observation per side.",
    );
  const leftInput = sources.get(sides.left[0] ?? "");
  const rightInput = sources.get(sides.right[0] ?? "");
  if (leftInput === undefined || rightInput === undefined)
    throw new TypeError("Web comparison source Evidence is missing.");
  const left = readWebComparisonSource(leftInput);
  const right = readWebComparisonSource(rightInput);
  if (comparison.operation === "compare_web_screenshots")
    return {
      kind: "web-screenshot",
      facts: prepareScreenshotFacts(comparison, left, right),
    };
  const policy = webCaptureComparisonPolicySchema.parse(comparison.parameters);
  const request = webCaptureSourceInput(left, right, policy);
  const result = browserCaptureComparisonSchema.parse(
    comparison.normalized_result,
  );
  assertDerivedResult(result, compareBrowserCaptures(request));
  const assessment = webComparisonSourceAssessment(
    left,
    right,
    undefined,
    policy.origin_mapping,
  );
  if (!("comparison_kind" in result))
    return { kind: "web-capture", result, ...assessment };
  if (result.alignment.status !== "aligned")
    assessment.coverage.push(
      "Browser scenario steps or capture contexts do not align completely.",
    );
  return prepareScenarioFacts(
    result,
    {
      before: readWebScenarioSource(left).capture,
      after: readWebScenarioSource(right).capture,
    },
    assessment,
  );
};

const prepareScenarioFacts = (
  result: BrowserScenarioDiff,
  sources: {
    readonly before: RetainedBrowserScenarioCapture;
    readonly after: RetainedBrowserScenarioCapture;
  },
  assessment: {
    readonly limitations: readonly string[];
    readonly coverage: readonly string[];
  },
): Extract<PreparedWebComparison, { kind: "web-scenario" }> => {
  const { before, after } = sources;
  const steps = new Map<string, ScenarioStatuses>();
  for (const step of result.steps) {
    const beforeStep = before.steps[step.before_step_index];
    const afterStep = after.steps[step.after_step_index];
    if (beforeStep === undefined || afterStep === undefined)
      throw new TypeError(
        "Scenario comparison references a missing source step.",
      );
    const statuses = new Map<string, ReconstructionObservedStatus>([
      ["overall", step.status],
    ]);
    for (const kind of browserScenarioArtifactKindSchema.options) {
      const difference = step.artifact_diffs.find(
        (diff) => diff.artifact === kind,
      );
      const status =
        difference?.status === "changed"
          ? "changed"
          : !artifactCaptured(kind, before, beforeStep) ||
              !artifactCaptured(kind, after, afterStep)
            ? "unknown"
            : (difference?.status ?? "unchanged");
      statuses.set(kind, status);
    }
    steps.set(step.step_id, statuses);
  }
  const all = new Map<string, ReconstructionObservedStatus>([
    ["overall", result.overall_status],
  ]);
  for (const kind of browserScenarioArtifactKindSchema.options) {
    const statuses = [...steps.values()].map(
      (step) => step.get(kind) ?? "unknown",
    );
    all.set(
      kind,
      statuses.includes("changed")
        ? "changed"
        : statuses.length === 0 || statuses.includes("unknown")
          ? "unknown"
          : "unchanged",
    );
  }
  return { kind: "web-scenario", steps, all, ...assessment };
};

const artifactCaptured = (
  kind: BrowserScenarioArtifactKind,
  capture: RetainedBrowserScenarioCapture,
  step: RetainedBrowserScenarioCapture["steps"][number],
): boolean => {
  if (kind === "action_state")
    return step.status === "completed" && step.completeness.equality_eligible;
  if (kind === "events")
    return (
      (capture.scenario.event_families?.length ?? 0) > 0 &&
      eventEvidenceState(capture, step) === "captured"
    );
  return (
    artifactEvidenceState<unknown>(kind, step.artifacts[kind], step) ===
    "captured"
  );
};

const screenshotPolicySchema = z.object({
  channel_threshold: z.number().int().min(0).max(255),
  step_id: z.string().min(1).optional(),
  before_artifact_sha256: z.string().optional(),
  after_artifact_sha256: z.string().optional(),
  origin_mapping: browserScenarioOriginMappingSchema.optional(),
});

const prepareScreenshotFacts = (
  comparison: Evidence,
  left: Evidence,
  right: Evidence,
): WebReconstructionFacts & { readonly coverage: readonly string[] } => {
  if (left.operation !== right.operation)
    throw new TypeError("Screenshot source observation types differ.");
  const policy = screenshotPolicySchema.parse(comparison.parameters);
  const before = webScreenshotSourceArtifact(left, policy.step_id);
  const after = webScreenshotSourceArtifact(right, policy.step_id);
  const result = webScreenshotComparisonResultSchema.parse(
    comparison.normalized_result,
  );
  const assessment = webComparisonSourceAssessment(
    left,
    right,
    policy.step_id,
    policy.origin_mapping,
  );
  if (before === undefined || after === undefined) {
    if (result.status !== "unavailable")
      throw new TypeError(
        "Screenshot comparison claims metrics without both captured images.",
      );
    return {
      observed: "unknown",
      ...assessment,
      limitations: [...assessment.limitations, result.reason],
    };
  }
  if (
    (policy.before_artifact_sha256 !== undefined &&
      policy.before_artifact_sha256 !== before.sha256) ||
    (policy.after_artifact_sha256 !== undefined &&
      policy.after_artifact_sha256 !== after.sha256)
  )
    throw new TypeError(
      "Screenshot comparison artifact identities disagree with source Evidence.",
    );
  if (result.status === "unavailable")
    throw new TypeError(
      "Screenshot comparison is unavailable despite two captured source images.",
    );
  const expected = comparePngScreenshots(
    compareWebScreenshotsInputSchema.parse({
      before,
      after,
      channel_threshold: policy.channel_threshold,
    }),
  );
  assertDerivedResult(result, expected);
  if (result.status === "dimension_mismatch")
    return {
      observed: "unknown",
      ...assessment,
      limitations: [
        ...assessment.limitations,
        "Captured PNG dimensions differ.",
      ],
    };
  return {
    observed: result.changed_ratio === 0 ? "unchanged" : "changed",
    ...assessment,
    measured_changed_ratio: result.changed_ratio,
  };
};

const assertDerivedResult = (actual: unknown, expected: unknown): void => {
  if (
    digestCanonicalValue(actual, "Web comparison") !==
    digestCanonicalValue(expected, "Web comparison")
  )
    throw new TypeError(
      "Web comparison result disagrees with its committed source Evidence and policy.",
    );
};

const assessCoverage = (
  observed: ReconstructionObservedStatus,
  assessment: {
    readonly limitations: readonly string[];
    readonly coverage: readonly string[];
  },
  acceptsDifference = false,
): Pick<WebReconstructionFacts, "limitations" | "diagnostics"> =>
  observed === "changed" && !acceptsDifference
    ? { limitations: assessment.limitations, diagnostics: assessment.coverage }
    : { limitations: [...assessment.limitations, ...assessment.coverage] };
