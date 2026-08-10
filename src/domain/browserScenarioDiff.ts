import {
  type BrowserScenarioCapture,
  type BrowserScenarioStep,
} from "./browserScenarioCapture.js";
import {
  actionState,
  artifactEvidenceState,
  captured,
  eventEvidenceState,
  eventsFor,
  screenshotProjection,
  type CaptureState,
} from "./browserScenarioDiffEvidence.js";
import {
  browserScenarioDiffSchema,
  type BrowserScenarioAlignmentFailure,
  type BrowserScenarioArtifactDiff,
  type BrowserScenarioArtifactKind,
  type BrowserScenarioDiff,
  type BrowserScenarioEvidenceState,
  type BrowserScenarioNormalizationRule,
  type CompareBrowserScenariosInput,
} from "./browserScenarioDiffValues.js";
import {
  commitBrowserScenarioNormalization,
  digestCanonicalJson,
  digestNormalizedScenarioValue,
} from "./browserScenarioNormalization.js";

export {
  browserScenarioDiffSchema,
  compareBrowserScenariosInputSchema,
  type BrowserScenarioDiff,
  type CompareBrowserScenariosInput,
} from "./browserScenarioDiffValues.js";

type ComparableArtifact = {
  readonly artifact: BrowserScenarioArtifactKind;
} & (
  | {
      readonly status: "unchanged" | "not_compared";
      readonly diff: null;
    }
  | {
      readonly status: "changed" | "unknown";
      readonly diff: BrowserScenarioArtifactDiff;
    }
);

interface ScenarioAlignment {
  readonly before: ReadonlyMap<string, BrowserScenarioStep>;
  readonly after: ReadonlyMap<string, BrowserScenarioStep>;
  readonly orderedStepIds: readonly string[];
  readonly beforeOnly: readonly string[];
  readonly afterOnly: readonly string[];
  readonly failures: readonly BrowserScenarioAlignmentFailure[];
}

interface AlignedStepComparison {
  readonly steps: BrowserScenarioDiff["steps"];
  readonly failures: readonly BrowserScenarioAlignmentFailure[];
  readonly totalArtifactDiffs: number;
}

/** Compare scenario steps by stable step ID and apply only committed literal rules. */
export const compareBrowserScenarios = (
  input: CompareBrowserScenariosInput,
): BrowserScenarioDiff => {
  const normalization = commitBrowserScenarioNormalization(input.normalization);
  const alignment = alignScenarioSteps(
    input.before_scenario,
    input.after_scenario,
  );
  const compared = compareAlignedSteps({
    beforeCapture: input.before_scenario,
    afterCapture: input.after_scenario,
    alignment,
    rules: normalization.rules,
    maxChanges: input.max_changes,
  });
  const failures = [...alignment.failures, ...compared.failures];
  const alignmentStatus =
    failures.length === 0
      ? "aligned"
      : compared.steps.length === 0
        ? "failed"
        : "partial";
  const stepStatuses = compared.steps.map(({ status }) => status);
  const equalityEligible =
    input.before_scenario.completeness.equality_eligible &&
    input.after_scenario.completeness.equality_eligible &&
    alignmentStatus === "aligned";
  const overallStatus = stepStatuses.includes("changed")
    ? "changed"
    : stepStatuses.includes("unknown") || !equalityEligible
      ? "unknown"
      : "unchanged";

  return browserScenarioDiffSchema.parse({
    schema_version: 1,
    comparison_kind: "browser_scenario",
    overall_status: overallStatus,
    normalization,
    alignment: {
      status: alignmentStatus,
      aligned_steps: compared.steps.length,
      before_only: alignment.beforeOnly,
      after_only: alignment.afterOnly,
      failures,
    },
    steps: compared.steps,
    artifact_diffs: {
      total: compared.totalArtifactDiffs,
      retained:
        compared.totalArtifactDiffs -
        Math.max(0, compared.totalArtifactDiffs - input.max_changes),
      omitted: Math.max(0, compared.totalArtifactDiffs - input.max_changes),
    },
    limitations: [
      "Steps align only by exact, unique step_id; missing, duplicate, or action-mismatched steps are reported and prevent an unchanged claim.",
      "Only declared literal normalization rules are applied, in canonical rule_id order, to already-redacted durable capture fields.",
      "Elapsed time and event sequence/index values are excluded as volatile; screenshot bytes are compared by content digest.",
      "A changed status proves an observed normalized difference. Missing or truncated evidence, incompatible capture context, or alignment failure prevents an unchanged claim.",
      ...(compared.totalArtifactDiffs > input.max_changes
        ? [
            `${String(compared.totalArtifactDiffs - input.max_changes)} artifact difference record(s) were omitted by max_changes.`,
          ]
        : []),
    ],
  });
};

const alignScenarioSteps = (
  beforeCapture: BrowserScenarioCapture,
  afterCapture: BrowserScenarioCapture,
): ScenarioAlignment => {
  const beforeDuplicates = duplicateStepIds(beforeCapture.steps);
  const afterDuplicates = duplicateStepIds(afterCapture.steps);
  const before = uniqueSteps(beforeCapture.steps, beforeDuplicates);
  const after = uniqueSteps(afterCapture.steps, afterDuplicates);
  const beforeOnly = [...before.keys()]
    .filter((stepId) => !after.has(stepId))
    .sort();
  const afterOnly = [...after.keys()]
    .filter((stepId) => !before.has(stepId))
    .sort();
  const failures: BrowserScenarioAlignmentFailure[] = [
    ...duplicateFailures("before", beforeDuplicates),
    ...duplicateFailures("after", afterDuplicates),
    ...missingFailures("before", afterOnly),
    ...missingFailures("after", beforeOnly),
  ];
  if (!captureContextsMatch(beforeCapture, afterCapture))
    failures.push({
      code: "capture_context_mismatch",
      step_id: null,
      reason:
        "Browser product/version or scenario origin scope differs between captures.",
    });
  return {
    before,
    after,
    beforeOnly,
    afterOnly,
    failures,
    orderedStepIds: beforeCapture.steps
      .map(({ step_id }) => step_id)
      .filter(
        (stepId, index, values) =>
          values.indexOf(stepId) === index &&
          before.has(stepId) &&
          after.has(stepId),
      ),
  };
};

interface CompareAlignedStepsInput {
  readonly beforeCapture: BrowserScenarioCapture;
  readonly afterCapture: BrowserScenarioCapture;
  readonly alignment: ScenarioAlignment;
  readonly rules: readonly BrowserScenarioNormalizationRule[];
  readonly maxChanges: number;
}

const compareAlignedSteps = (
  input: CompareAlignedStepsInput,
): AlignedStepComparison => {
  const remaining = { value: input.maxChanges };
  let totalArtifactDiffs = 0;
  const steps: BrowserScenarioDiff["steps"] = [];
  const failures: BrowserScenarioAlignmentFailure[] = [];
  for (const stepId of input.alignment.orderedStepIds) {
    const beforeStep = input.alignment.before.get(stepId);
    const afterStep = input.alignment.after.get(stepId);
    if (beforeStep === undefined || afterStep === undefined) continue;
    if (beforeStep.action !== afterStep.action)
      failures.push({
        code: "action_mismatch",
        step_id: stepId,
        reason: `Aligned step action changed from ${beforeStep.action} to ${afterStep.action}.`,
      });
    const artifacts = compareStepArtifacts({
      beforeCapture: input.beforeCapture,
      beforeStep,
      afterCapture: input.afterCapture,
      afterStep,
      rules: input.rules,
    });
    const reportable = artifacts.flatMap(({ diff }) =>
      diff === null ? [] : [diff],
    );
    totalArtifactDiffs += reportable.length;
    const retained = reportable.slice(0, remaining.value);
    remaining.value -= retained.length;
    const statuses = artifacts.map(({ status }) => status);
    steps.push({
      step_id: stepId,
      before_step_index: beforeStep.step_index,
      after_step_index: afterStep.step_index,
      before_action: beforeStep.action,
      after_action: afterStep.action,
      status: statuses.includes("changed")
        ? "changed"
        : statuses.includes("unknown")
          ? "unknown"
          : "unchanged",
      artifact_diffs: retained,
      omitted_artifact_diffs: reportable.length - retained.length,
    });
  }
  return { steps, failures, totalArtifactDiffs };
};

const duplicateStepIds = (
  steps: readonly BrowserScenarioStep[],
): ReadonlySet<string> => {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const { step_id: stepId } of steps) {
    if (seen.has(stepId)) duplicates.add(stepId);
    seen.add(stepId);
  }
  return duplicates;
};

const uniqueSteps = (
  steps: readonly BrowserScenarioStep[],
  duplicates: ReadonlySet<string>,
): ReadonlyMap<string, BrowserScenarioStep> =>
  new Map(
    steps.flatMap((step) =>
      duplicates.has(step.step_id) ? [] : [[step.step_id, step] as const],
    ),
  );

const duplicateFailures = (
  side: "before" | "after",
  duplicates: ReadonlySet<string>,
): BrowserScenarioAlignmentFailure[] =>
  [...duplicates].sort().map((stepId) => ({
    code:
      side === "before"
        ? "duplicate_before_step_id"
        : "duplicate_after_step_id",
    step_id: stepId,
    reason: `${side} capture contains duplicate step_id ${stepId}.`,
  }));

const missingFailures = (
  side: "before" | "after",
  stepIds: readonly string[],
): BrowserScenarioAlignmentFailure[] =>
  stepIds.map((stepId) => ({
    code: side === "before" ? "missing_before_step" : "missing_after_step",
    step_id: stepId,
    reason: `Step ${stepId} is missing from the ${side} capture.`,
  }));

const captureContextsMatch = (
  before: BrowserScenarioCapture,
  after: BrowserScenarioCapture,
): boolean =>
  before.browser.product === after.browser.product &&
  before.browser.version === after.browser.version &&
  before.scenario.start_origin === after.scenario.start_origin &&
  digestCanonicalJson([...before.scenario.allowed_origins].sort()) ===
    digestCanonicalJson([...after.scenario.allowed_origins].sort());

interface CompareStepArtifactsInput {
  readonly beforeCapture: BrowserScenarioCapture;
  readonly beforeStep: BrowserScenarioStep;
  readonly afterCapture: BrowserScenarioCapture;
  readonly afterStep: BrowserScenarioStep;
  readonly rules: readonly BrowserScenarioNormalizationRule[];
}

const compareStepArtifacts = (
  input: CompareStepArtifactsInput,
): ComparableArtifact[] => {
  const common = {
    beforeStep: input.beforeStep,
    afterStep: input.afterStep,
    rules: input.rules,
  };
  return [
    compareCapturedValues({
      ...common,
      artifact: "action_state",
      before: captured(actionState(input.beforeStep)),
      after: captured(actionState(input.afterStep)),
    }),
    compareCapturedValues({
      ...common,
      artifact: "screenshot",
      before: input.beforeStep.artifacts.screenshot,
      after: input.afterStep.artifacts.screenshot,
      project: screenshotProjection,
    }),
    compareCapturedValues({
      ...common,
      artifact: "dom",
      before: input.beforeStep.artifacts.dom,
      after: input.afterStep.artifacts.dom,
      project: ({ text }) => text,
    }),
    compareCapturedValues({
      ...common,
      artifact: "accessibility",
      before: input.beforeStep.artifacts.accessibility,
      after: input.afterStep.artifacts.accessibility,
      project: ({ text }) => text,
    }),
    compareCapturedValues({
      ...common,
      artifact: "url",
      before: input.beforeStep.artifacts.url,
      after: input.afterStep.artifacts.url,
    }),
    compareCapturedValues({
      ...common,
      artifact: "history",
      before: input.beforeStep.artifacts.history,
      after: input.afterStep.artifacts.history,
    }),
    compareCapturedValues({
      ...common,
      artifact: "storage",
      before: input.beforeStep.artifacts.storage,
      after: input.afterStep.artifacts.storage,
    }),
    compareCapturedValues({
      ...common,
      artifact: "events",
      before: captured(
        eventsFor(input.beforeCapture, input.beforeStep.step_index),
      ),
      after: captured(
        eventsFor(input.afterCapture, input.afterStep.step_index),
      ),
      beforeState: eventEvidenceState(input.beforeCapture, input.beforeStep),
      afterState: eventEvidenceState(input.afterCapture, input.afterStep),
    }),
  ];
};

interface CompareCapturedValuesInput<Value> {
  readonly artifact: BrowserScenarioArtifactKind;
  readonly before: CaptureState<Value>;
  readonly after: CaptureState<Value>;
  readonly beforeStep: BrowserScenarioStep;
  readonly afterStep: BrowserScenarioStep;
  readonly rules: readonly BrowserScenarioNormalizationRule[];
  readonly project?: (value: Value) => unknown;
  readonly beforeState?: BrowserScenarioEvidenceState;
  readonly afterState?: BrowserScenarioEvidenceState;
}

const compareCapturedValues = <Value>(
  input: CompareCapturedValuesInput<Value>,
): ComparableArtifact => {
  const {
    artifact,
    before,
    after,
    beforeStep,
    afterStep,
    rules,
    project = (value) => value,
  } = input;
  const beforeState =
    input.beforeState ?? artifactEvidenceState(artifact, before, beforeStep);
  const afterState =
    input.afterState ?? artifactEvidenceState(artifact, after, afterStep);
  if (beforeState === "not_requested" && afterState === "not_requested")
    return { artifact, status: "not_compared", diff: null };
  const beforeSha256 =
    beforeState === "captured" && before.state === "captured"
      ? digestNormalizedScenarioValue(project(before.value), artifact, rules)
      : null;
  const afterSha256 =
    afterState === "captured" && after.state === "captured"
      ? digestNormalizedScenarioValue(project(after.value), artifact, rules)
      : null;
  if (
    beforeState !== "captured" ||
    afterState !== "captured" ||
    before.state !== "captured" ||
    after.state !== "captured"
  )
    return {
      artifact,
      status: "unknown",
      diff: {
        artifact,
        status: "unknown",
        before_state: beforeState,
        after_state: afterState,
        before_sha256: beforeSha256,
        after_sha256: afterSha256,
        reason: `Artifact coverage is not comparable (${beforeState} before, ${afterState} after).`,
      },
    };
  if (beforeSha256 === null || afterSha256 === null)
    throw new TypeError("Captured artifact digest refinement failed");
  if (beforeSha256 === afterSha256)
    return { artifact, status: "unchanged", diff: null };
  return {
    artifact,
    status: "changed",
    diff: {
      artifact,
      status: "changed",
      before_state: beforeState,
      after_state: afterState,
      before_sha256: beforeSha256,
      after_sha256: afterSha256,
      reason: null,
    },
  };
};
