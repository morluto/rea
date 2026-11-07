import {
  type AnalysisRunEnvelope,
  analysisRunEnvelopeSchema,
  type AnalysisRunIncompatibility,
  type AnalysisRunIncompatibilityCode,
  analysisRunIncompatibilitySchema,
  type CompareAnalysisRunsOptions,
  supportedAnalysisRunResultTypeSchema,
} from "./analysisRunComparisonSchemas.js";
import { err, ok, type Result } from "./result.js";

export interface CandidateRunSummary {
  readonly run_id: string | null;
  readonly result_type: string | null;
  readonly operation: string | null;
  readonly predicate_type: string | null;
  readonly subject_format: string | null;
  readonly subject_architecture: string | null;
  readonly provider_id: string | null;
}

export interface SummaryPair {
  readonly leftSummary: CandidateRunSummary | null;
  readonly rightSummary: CandidateRunSummary | null;
}

const getStringProp = (
  record: Record<string, unknown> | null,
  key: string,
): string | null =>
  record !== null &&
  Object.hasOwn(record, key) &&
  typeof record[key] === "string"
    ? record[key]
    : null;

const getObjectProp = (
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null =>
  Object.hasOwn(record, key) &&
  typeof record[key] === "object" &&
  record[key] !== null
    ? (record[key] as Record<string, unknown>)
    : null;

export const summarizeCandidateRun = (
  candidate: unknown,
): CandidateRunSummary | null => {
  if (typeof candidate !== "object" || candidate === null) return null;
  const record = candidate as Record<string, unknown>;
  const subject = getObjectProp(record, "subject");
  const provider = getObjectProp(record, "provider");
  return {
    run_id: getStringProp(record, "run_id"),
    result_type: getStringProp(record, "result_type"),
    operation: getStringProp(record, "operation"),
    predicate_type: getStringProp(record, "predicate_type"),
    subject_format: getStringProp(subject, "format"),
    subject_architecture: getStringProp(subject, "architecture"),
    provider_id: getStringProp(provider, "id"),
  };
};

const makeIncompatibility = (
  code: AnalysisRunIncompatibilityCode,
  explanation: string,
  summaries: SummaryPair,
): Result<never, AnalysisRunIncompatibility> =>
  err(
    analysisRunIncompatibilitySchema.parse({
      compatible: false,
      code,
      explanation,
      left_summary: summaries.leftSummary,
      right_summary: summaries.rightSummary,
    }),
  );

const findDuplicateIdentity = (keys: readonly string[]): string | undefined => {
  const seen = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) return key;
    seen.add(key);
  }
  return undefined;
};

const checkDuplicateRunIdentities = (
  run: AnalysisRunEnvelope,
  sideLabel: "left" | "right",
): string | undefined => {
  const checks = [
    ["procedure address", (run.procedures ?? []).map((i) => i.address)],
    ["finding_id", (run.findings ?? []).map((i) => i.finding_id)],
    ["obligation_id", (run.obligations ?? []).map((i) => i.obligation_id)],
    ["unknown_id", (run.unknowns ?? []).map((i) => i.unknown_id)],
  ] as const;
  for (const [label, keys] of checks) {
    const duplicate = findDuplicateIdentity(keys);
    if (duplicate !== undefined) {
      return `The ${sideLabel} analysis run (${run.run_id}) contains duplicate ${label} ${JSON.stringify(duplicate)}; reliable finding matching requires unique per-run item identities.`;
    }
  }
  return undefined;
};

const checkSubjectCompatibility = (
  left: AnalysisRunEnvelope,
  right: AnalysisRunEnvelope,
  summaries: SummaryPair,
): Result<void, AnalysisRunIncompatibility> => {
  if ((left.subject === null) !== (right.subject === null)) {
    return makeIncompatibility(
      "incompatible_subject_format",
      `Cannot compare subject ${JSON.stringify(left.subject?.format ?? null)} (${left.run_id}) with ${JSON.stringify(right.subject?.format ?? null)} (${right.run_id}): one run binds a subject artifact while the other does not.`,
      summaries,
    );
  }
  if (left.subject !== null && right.subject !== null) {
    if (left.subject.format !== right.subject.format) {
      return makeIncompatibility(
        "incompatible_subject_format",
        `Cannot compare subject format ${JSON.stringify(left.subject.format)} (${left.run_id}) with ${JSON.stringify(right.subject.format)} (${right.run_id}): artifact formats are incompatible.`,
        summaries,
      );
    }
    if (left.subject.architecture !== right.subject.architecture) {
      return makeIncompatibility(
        "incompatible_subject_architecture",
        `Cannot compare subject architecture ${JSON.stringify(left.subject.architecture)} (${left.run_id}) with ${JSON.stringify(right.subject.architecture)} (${right.run_id}): procedure and address semantics are incompatible across architectures.`,
        summaries,
      );
    }
  }
  return ok(undefined);
};

const hasUnsupportedResultType = (
  summary: CandidateRunSummary | null,
): boolean =>
  summary?.result_type !== null &&
  summary?.result_type !== undefined &&
  !supportedAnalysisRunResultTypeSchema.safeParse(summary.result_type).success;

const checkPairSemanticCompatibility = (
  left: AnalysisRunEnvelope,
  right: AnalysisRunEnvelope,
  summaries: SummaryPair,
  options?: CompareAnalysisRunsOptions,
): Result<void, AnalysisRunIncompatibility> => {
  if (left.result_type !== right.result_type) {
    return makeIncompatibility(
      "incompatible_result_type",
      `Cannot compare ${left.result_type} (${left.run_id}) with ${right.result_type} (${right.run_id}): result types must match so findings share a common identity and semantic model.`,
      summaries,
    );
  }
  if (left.operation !== right.operation) {
    return makeIncompatibility(
      "incompatible_operation",
      `Cannot compare operation ${JSON.stringify(left.operation)} (${left.run_id}) with ${JSON.stringify(right.operation)} (${right.run_id}): compatible analysis runs must execute the same analysis operation.`,
      summaries,
    );
  }
  if (left.predicate_type !== right.predicate_type) {
    return makeIncompatibility(
      "incompatible_predicate_type",
      `Cannot compare predicate_type ${JSON.stringify(left.predicate_type)} (${left.run_id}) with ${JSON.stringify(right.predicate_type)} (${right.run_id}): predicate schemas are incompatible.`,
      summaries,
    );
  }
  const subjectCheck = checkSubjectCompatibility(left, right, summaries);
  if (!subjectCheck.ok) return subjectCheck;

  if (
    options?.require_same_provider === true &&
    left.provider.id !== right.provider.id
  ) {
    return makeIncompatibility(
      "incompatible_provider",
      `Cannot compare provider ${JSON.stringify(left.provider.id)} (${left.run_id}) with ${JSON.stringify(right.provider.id)} (${right.run_id}) when require_same_provider is enabled.`,
      summaries,
    );
  }
  return ok(undefined);
};

/**
 * Validate whether two analysis run inputs are compatible for focused comparison.
 * Returns a structured explanation when comparison is unsupported or incompatible.
 */
export const checkAnalysisRunCompatibility = (
  leftInput: unknown,
  rightInput: unknown,
  options?: CompareAnalysisRunsOptions,
): Result<
  { readonly left: AnalysisRunEnvelope; readonly right: AnalysisRunEnvelope },
  AnalysisRunIncompatibility
> => {
  const summaries: SummaryPair = {
    leftSummary: summarizeCandidateRun(leftInput),
    rightSummary: summarizeCandidateRun(rightInput),
  };

  if (
    hasUnsupportedResultType(summaries.leftSummary) ||
    hasUnsupportedResultType(summaries.rightSummary)
  ) {
    return makeIncompatibility(
      "unsupported_result_type",
      `Comparison is unsupported for result types (${String(summaries.leftSummary?.result_type ?? "unknown")} vs ${String(summaries.rightSummary?.result_type ?? "unknown")}); only ${supportedAnalysisRunResultTypeSchema.options.join(", ")} have reliable finding identity rules.`,
      summaries,
    );
  }

  const parsedLeft = analysisRunEnvelopeSchema.safeParse(leftInput);
  if (!parsedLeft.success) {
    const issueText = parsedLeft.error.issues
      .map((issue) => `${issue.path.join(".") || "left"}: ${issue.message}`)
      .join("; ");
    return makeIncompatibility(
      "invalid_run_schema",
      `Left analysis run does not match the analysis run schema: ${issueText}`,
      summaries,
    );
  }

  const parsedRight = analysisRunEnvelopeSchema.safeParse(rightInput);
  if (!parsedRight.success) {
    const issueText = parsedRight.error.issues
      .map((issue) => `${issue.path.join(".") || "right"}: ${issue.message}`)
      .join("; ");
    return makeIncompatibility(
      "invalid_run_schema",
      `Right analysis run does not match the analysis run schema: ${issueText}`,
      summaries,
    );
  }

  const left = parsedLeft.data;
  const right = parsedRight.data;
  const pairCheck = checkPairSemanticCompatibility(
    left,
    right,
    summaries,
    options,
  );
  if (!pairCheck.ok) return pairCheck;

  const leftDuplicate = checkDuplicateRunIdentities(left, "left");
  if (leftDuplicate !== undefined) {
    return makeIncompatibility(
      "duplicate_item_identity",
      leftDuplicate,
      summaries,
    );
  }
  const rightDuplicate = checkDuplicateRunIdentities(right, "right");
  if (rightDuplicate !== undefined) {
    return makeIncompatibility(
      "duplicate_item_identity",
      rightDuplicate,
      summaries,
    );
  }

  return ok({ left, right });
};
