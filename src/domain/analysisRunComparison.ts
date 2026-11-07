import { AnalysisInputError } from "./analysisErrorCore.js";
import { checkAnalysisRunCompatibility } from "./analysisRunComparisonCompatibility.js";
import {
  diffRecordFieldNames,
  extractNormalizedRunItems,
  sortUniqueStrings,
} from "./analysisRunComparisonNormalization.js";
import {
  type AnalysisRunComparisonReport,
  analysisRunComparisonReportSchema,
  type AnalysisRunCoverage,
  type AnalysisRunCoverageDelta,
  type AnalysisRunEnvelope,
  type AnalysisRunIncompatibility,
  type AnalysisRunItemDelta,
  type AnalysisRunItemStatus,
  type AnalysisRunObligationStatus,
  type CompareAnalysisRunsOptions,
  DEFAULT_ANALYSIS_RUN_IGNORED_FIELDS,
  type NormalizedComparisonItem,
} from "./analysisRunComparisonSchemas.js";
import { digestCanonicalValue } from "./canonicalDigest.js";
import { absenceClaimable } from "./comparisonSemantics.js";
import { freezeJsonSnapshot } from "./immutableJson.js";
import { ok, type Result } from "./result.js";
import {
  compareUnicodeCodePoints,
  compositeKey,
} from "./unicodeCodePointOrder.js";

export { checkAnalysisRunCompatibility } from "./analysisRunComparisonCompatibility.js";
export * from "./analysisRunComparisonSchemas.js";

const DEFAULT_COMPLETE_COVERAGE: AnalysisRunCoverage = Object.freeze({
  status: "complete",
  truncated: false,
  omitted_count: 0,
  reason: null,
});

const isCoverageComplete = (coverage: AnalysisRunCoverage): boolean =>
  absenceClaimable({
    status: coverage.status,
    ...(coverage.truncated === undefined
      ? {}
      : { truncated: coverage.truncated }),
    ...(coverage.omitted_count === undefined
      ? {}
      : { omitted_count: coverage.omitted_count }),
  });

const coverageRank = (coverage: AnalysisRunCoverage): number => {
  if (isCoverageComplete(coverage)) return 3;
  if (coverage.status === "partial" || coverage.status === "complete") return 2;
  return 1;
};

const computeCoverageDelta = (
  leftCoverage: AnalysisRunCoverage,
  rightCoverage: AnalysisRunCoverage,
): AnalysisRunCoverageDelta => {
  const leftComplete = isCoverageComplete(leftCoverage);
  const rightComplete = isCoverageComplete(rightCoverage);
  const leftRank = coverageRank(leftCoverage);
  const rightRank = coverageRank(rightCoverage);
  const leftOmitted = leftCoverage.omitted_count ?? 0;
  const rightOmitted = rightCoverage.omitted_count ?? 0;
  const omittedDelta = rightOmitted - leftOmitted;

  const leftTruncated = leftCoverage.truncated ?? false;
  const rightTruncated = rightCoverage.truncated ?? false;
  let transition: "unchanged" | "improved" | "regressed" = "unchanged";
  if (
    rightRank > leftRank ||
    (rightRank === leftRank && omittedDelta < 0) ||
    (rightRank === leftRank &&
      omittedDelta === 0 &&
      leftTruncated &&
      !rightTruncated)
  ) {
    transition = "improved";
  } else if (
    rightRank < leftRank ||
    (rightRank === leftRank && omittedDelta > 0) ||
    (rightRank === leftRank &&
      omittedDelta === 0 &&
      !leftTruncated &&
      rightTruncated)
  ) {
    transition = "regressed";
  }

  return {
    left_status: leftCoverage.status,
    right_status: rightCoverage.status,
    left_complete: leftComplete,
    right_complete: rightComplete,
    left_omitted_count: leftOmitted,
    right_omitted_count: rightOmitted,
    omitted_count_delta: omittedDelta,
    transition,
  };
};

const obligationRank = (status: AnalysisRunObligationStatus): number => {
  if (status === "verified") return 3;
  if (status === "open") return 2;
  return status === "unsatisfied" ? 1 : 0;
};

const createKindCounters = () => ({
  procedure: { unchanged: 0, changed: 0, added: 0, removed: 0, unknown: 0 },
  finding: { unchanged: 0, changed: 0, added: 0, removed: 0, unknown: 0 },
  obligation: {
    improved: 0,
    regressed: 0,
    unchanged: 0,
    added: 0,
    removed: 0,
    unknown: 0,
  },
  residual_unknown: {
    resolved: 0,
    reopened: 0,
    unchanged: 0,
    added: 0,
    removed: 0,
    unknown: 0,
  },
  presentationOnlyCount: 0,
});

type KindCounters = ReturnType<typeof createKindCounters>;

const recordMatchedKindCount = (
  counters: KindCounters,
  leftItem: NormalizedComparisonItem,
  rightItem: NormalizedComparisonItem,
  semanticChanged: boolean,
): void => {
  const status: "changed" | "unchanged" = semanticChanged
    ? "changed"
    : "unchanged";
  if (leftItem.item_kind === "procedure") {
    counters.procedure[status] += 1;
    return;
  }
  if (leftItem.item_kind === "finding") {
    counters.finding[status] += 1;
    return;
  }
  if (leftItem.item_kind === "obligation") {
    const leftRank = obligationRank(leftItem.obligation_status ?? "open");
    const rightRank = obligationRank(rightItem.obligation_status ?? "open");
    if (!semanticChanged || rightRank === leftRank)
      counters.obligation.unchanged += 1;
    else if (rightRank > leftRank) counters.obligation.improved += 1;
    else counters.obligation.regressed += 1;
    return;
  }
  if (!semanticChanged) counters.residual_unknown.unchanged += 1;
  else if (
    leftItem.unknown_status !== "resolved" &&
    rightItem.unknown_status === "resolved"
  )
    counters.residual_unknown.resolved += 1;
  else if (
    leftItem.unknown_status === "resolved" &&
    rightItem.unknown_status !== "resolved"
  )
    counters.residual_unknown.reopened += 1;
  else counters.residual_unknown.unchanged += 1;
};

const recordUnmatchedKindCount = (
  counters: KindCounters,
  kind: NormalizedComparisonItem["item_kind"],
  status: "added" | "removed" | "unknown",
): void => {
  if (kind === "procedure") counters.procedure[status] += 1;
  else if (kind === "finding") counters.finding[status] += 1;
  else if (kind === "obligation") counters.obligation[status] += 1;
  else counters.residual_unknown[status] += 1;
};

interface DeltaBuildContext {
  readonly left: AnalysisRunEnvelope;
  readonly right: AnalysisRunEnvelope;
  readonly coverageDelta: AnalysisRunCoverageDelta;
  readonly counters: KindCounters;
}

const buildMatchedDelta = (
  key: string,
  leftItem: NormalizedComparisonItem,
  rightItem: NormalizedComparisonItem,
  ctx: DeltaBuildContext,
): AnalysisRunItemDelta => {
  const semanticChanged =
    leftItem.semantic_digest !== rightItem.semantic_digest;
  const changedFields = semanticChanged
    ? diffRecordFieldNames(leftItem.semantic_fields, rightItem.semantic_fields)
    : [];
  const presentationFieldsChanged = diffRecordFieldNames(
    leftItem.presentation_fields,
    rightItem.presentation_fields,
  );
  const presentationOnlyChange =
    !semanticChanged && presentationFieldsChanged.length > 0;
  if (presentationOnlyChange) ctx.counters.presentationOnlyCount += 1;

  recordMatchedKindCount(ctx.counters, leftItem, rightItem, semanticChanged);
  const status: AnalysisRunItemStatus = semanticChanged
    ? "changed"
    : "unchanged";

  return {
    item_kind: leftItem.item_kind,
    item_key: key,
    matching_rule: leftItem.matching_rule,
    status,
    conclusion_kind: "derived_relationship",
    presentation_only_change: presentationOnlyChange,
    changed_fields: changedFields,
    presentation_fields_changed: presentationFieldsChanged,
    unknown_reason: null,
    left_semantic_digest: leftItem.semantic_digest,
    right_semantic_digest: rightItem.semantic_digest,
    left_record_ref: {
      run_id: ctx.left.run_id,
      evidence_id: ctx.left.evidence_id,
      record_pointer: leftItem.record_pointer,
    },
    right_record_ref: {
      run_id: ctx.right.run_id,
      evidence_id: ctx.right.evidence_id,
      record_pointer: rightItem.record_pointer,
    },
    evidence_links: sortUniqueStrings([
      ...leftItem.evidence_ids,
      ...rightItem.evidence_ids,
    ]),
  };
};

const buildUnmatchedDelta = (
  key: string,
  side: "left_only" | "right_only",
  item: NormalizedComparisonItem,
  ctx: DeltaBuildContext,
): AnalysisRunItemDelta => {
  const otherComplete =
    side === "left_only"
      ? ctx.coverageDelta.right_complete
      : ctx.coverageDelta.left_complete;
  const run = side === "left_only" ? ctx.left : ctx.right;
  const status = otherComplete
    ? side === "left_only"
      ? "removed"
      : "added"
    : "unknown";
  recordUnmatchedKindCount(ctx.counters, item.item_kind, status);
  const ref = {
    run_id: run.run_id,
    evidence_id: run.evidence_id,
    record_pointer: item.record_pointer,
  };
  return {
    item_kind: item.item_kind,
    item_key: key,
    matching_rule: item.matching_rule,
    status,
    conclusion_kind: otherComplete
      ? "derived_relationship"
      : "unresolved_branch",
    presentation_only_change: false,
    changed_fields: [],
    presentation_fields_changed: [],
    unknown_reason: otherComplete
      ? null
      : side === "left_only"
        ? "right_run_incomplete"
        : "left_run_incomplete",
    left_semantic_digest: side === "left_only" ? item.semantic_digest : null,
    right_semantic_digest: side === "right_only" ? item.semantic_digest : null,
    left_record_ref: side === "left_only" ? ref : null,
    right_record_ref: side === "right_only" ? ref : null,
    evidence_links: [...item.evidence_ids],
  };
};

const buildReportLimitations = (
  left: AnalysisRunEnvelope,
  right: AnalysisRunEnvelope,
  coveragePair: {
    readonly leftCoverage: AnalysisRunCoverage;
    readonly rightCoverage: AnalysisRunCoverage;
    readonly coverageDelta: AnalysisRunCoverageDelta;
  },
): string[] => {
  const { leftCoverage, rightCoverage, coverageDelta } = coveragePair;
  return sortUniqueStrings([
    ...(left.limitations ?? []).map((note) => `Left (${left.run_id}): ${note}`),
    ...(right.limitations ?? []).map(
      (note) => `Right (${right.run_id}): ${note}`,
    ),
    ...(leftCoverage.limitations ?? []).map(
      (note) => `Left coverage (${left.run_id}): ${note}`,
    ),
    ...(rightCoverage.limitations ?? []).map(
      (note) => `Right coverage (${right.run_id}): ${note}`,
    ),
    ...(typeof leftCoverage.reason === "string"
      ? [`Left coverage reason (${left.run_id}): ${leftCoverage.reason}`]
      : []),
    ...(typeof rightCoverage.reason === "string"
      ? [`Right coverage reason (${right.run_id}): ${rightCoverage.reason}`]
      : []),
    ...(!coverageDelta.left_complete
      ? [
          `Left analysis run (${left.run_id}) has incomplete relationship coverage (${leftCoverage.status}, truncated=${String(leftCoverage.truncated ?? false)}, omitted_count=${String(leftCoverage.omitted_count ?? 0)}); items present only in the right run are classified as unknown rather than added.`,
        ]
      : []),
    ...(!coverageDelta.right_complete
      ? [
          `Right analysis run (${right.run_id}) has incomplete relationship coverage (${rightCoverage.status}, truncated=${String(rightCoverage.truncated ?? false)}, omitted_count=${String(rightCoverage.omitted_count ?? 0)}); items absent from the right run are classified as unknown rather than removed.`,
        ]
      : []),
    ...(left.provider.id !== right.provider.id
      ? [
          `Left provider (${left.provider.id}) differs from right provider (${right.provider.id}); only items with explicit matching keys were compared.`,
        ]
      : []),
    ...((left.analysis_profile_digest ?? null) !==
    (right.analysis_profile_digest ?? null)
      ? [
          `Analysis profile digest differs between left (${String(left.analysis_profile_digest ?? null)}) and right (${String(right.analysis_profile_digest ?? null)}).`,
        ]
      : []),
  ]);
};

const stripPositionalPointerForDigest = (delta: AnalysisRunItemDelta) => ({
  ...delta,
  left_record_ref:
    delta.left_record_ref === null
      ? null
      : {
          run_id: delta.left_record_ref.run_id,
          evidence_id: delta.left_record_ref.evidence_id,
        },
  right_record_ref:
    delta.right_record_ref === null
      ? null
      : {
          run_id: delta.right_record_ref.run_id,
          evidence_id: delta.right_record_ref.evidence_id,
        },
});

const collectComparisonDeltas = (
  leftItems: ReadonlyMap<string, NormalizedComparisonItem>,
  rightItems: ReadonlyMap<string, NormalizedComparisonItem>,
  ctx: DeltaBuildContext,
): AnalysisRunItemDelta[] => {
  const allItemKeys = sortUniqueStrings([
    ...leftItems.keys(),
    ...rightItems.keys(),
  ]);
  const items: AnalysisRunItemDelta[] = [];
  for (const key of allItemKeys) {
    const leftItem = leftItems.get(key);
    const rightItem = rightItems.get(key);
    if (leftItem !== undefined && rightItem !== undefined) {
      items.push(buildMatchedDelta(key, leftItem, rightItem, ctx));
    } else if (leftItem !== undefined) {
      items.push(buildUnmatchedDelta(key, "left_only", leftItem, ctx));
    } else if (rightItem !== undefined) {
      items.push(buildUnmatchedDelta(key, "right_only", rightItem, ctx));
    }
  }
  return [...items].sort((a, b) =>
    compareUnicodeCodePoints(
      compositeKey([a.item_kind, a.item_key]),
      compositeKey([b.item_kind, b.item_key]),
    ),
  );
};

/**
 * Compare two analysis runs and return either a deterministic comparison report
 * or a structured incompatibility explanation. Does not mutate input records.
 */
export const compareAnalysisRuns = (
  leftInput: unknown,
  rightInput: unknown,
  options?: CompareAnalysisRunsOptions,
): Result<AnalysisRunComparisonReport, AnalysisRunIncompatibility> => {
  const compatibility = checkAnalysisRunCompatibility(
    leftInput,
    rightInput,
    options,
  );
  if (!compatibility.ok) return compatibility;

  const { left, right } = compatibility.value;
  const ignoredFieldsList = sortUniqueStrings([
    ...DEFAULT_ANALYSIS_RUN_IGNORED_FIELDS,
    ...(options?.ignore_fields ?? []),
  ]);
  const ignoredFieldsSet = new Set(ignoredFieldsList);

  const leftCoverage = left.relationship_coverage ?? DEFAULT_COMPLETE_COVERAGE;
  const rightCoverage =
    right.relationship_coverage ?? DEFAULT_COMPLETE_COVERAGE;
  const coverageDelta = computeCoverageDelta(leftCoverage, rightCoverage);
  const counters = createKindCounters();

  const sortedItems = collectComparisonDeltas(
    extractNormalizedRunItems(left, ignoredFieldsSet),
    extractNormalizedRunItems(right, ignoredFieldsSet),
    { left, right, coverageDelta, counters },
  );
  const changes = sortedItems.filter((item) => item.status !== "unchanged");

  const summary = {
    total_items: sortedItems.length,
    unchanged: sortedItems.filter((item) => item.status === "unchanged").length,
    presentation_only: counters.presentationOnlyCount,
    changed: sortedItems.filter((item) => item.status === "changed").length,
    added: sortedItems.filter((item) => item.status === "added").length,
    removed: sortedItems.filter((item) => item.status === "removed").length,
    unknown: sortedItems.filter((item) => item.status === "unknown").length,
    by_kind: {
      procedure: counters.procedure,
      finding: counters.finding,
      obligation: counters.obligation,
      residual_unknown: counters.residual_unknown,
    },
  };

  const hasPositiveChange =
    summary.changed > 0 || summary.added > 0 || summary.removed > 0;
  const overallStatus: "unchanged" | "changed" | "unknown" =
    summary.unknown > 0
      ? "unknown"
      : hasPositiveChange
        ? "changed"
        : !coverageDelta.left_complete || !coverageDelta.right_complete
          ? "unknown"
          : "unchanged";

  const unsignedReport = {
    status: overallStatus,
    result_type: left.result_type,
    operation: left.operation,
    predicate_type: left.predicate_type,
    same_artifact_sha256:
      left.subject !== null && right.subject !== null
        ? left.subject.sha256 === right.subject.sha256
        : null,
    left_run: {
      run_id: left.run_id,
      evidence_id: left.evidence_id,
      subject_sha256: left.subject?.sha256 ?? null,
      provider_id: left.provider.id,
    },
    right_run: {
      run_id: right.run_id,
      evidence_id: right.evidence_id,
      subject_sha256: right.subject?.sha256 ?? null,
      provider_id: right.provider.id,
    },
    ignored_presentation_fields: ignoredFieldsList,
    coverage_delta: coverageDelta,
    summary,
    changes,
    items: sortedItems,
    limitations: buildReportLimitations(left, right, {
      leftCoverage,
      rightCoverage,
      coverageDelta,
    }),
  };

  const comparisonId = `arcr_${digestCanonicalValue(
    {
      ...unsignedReport,
      changes: changes.map(stripPositionalPointerForDigest),
      items: sortedItems.map(stripPositionalPointerForDigest),
    },
    "Analysis run comparison report",
  )}`;

  return ok(
    freezeJsonSnapshot(
      analysisRunComparisonReportSchema.parse({
        comparison_id: comparisonId,
        ...unsignedReport,
      }),
    ),
  );
};

/**
 * Compare two compatible analysis runs or throw an `AnalysisInputError` with
 * the incompatibility explanation when comparison is unsupported.
 */
export const compareCompatibleAnalysisRuns = (
  leftInput: unknown,
  rightInput: unknown,
  options?: CompareAnalysisRunsOptions,
): AnalysisRunComparisonReport => {
  const result = compareAnalysisRuns(leftInput, rightInput, options);
  if (!result.ok) {
    throw new AnalysisInputError(
      "compare-analysis-runs",
      { userMessage: result.error.explanation },
      [
        {
          path: ["right"],
          reason: "invalid_value",
          message: result.error.explanation,
        },
      ],
    );
  }
  return result.value;
};
