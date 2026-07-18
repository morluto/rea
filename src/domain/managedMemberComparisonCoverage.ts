import type {
  ManagedMemberComparisonResult,
  ManagedMemberComparisonSide,
} from "./managedMemberComparison.js";
import type { ManagedMemberInspection } from "./managedArtifact.js";

interface PageAssessment {
  readonly sourceComplete: boolean;
  readonly sourceOmittedCount: number;
}

interface ComparisonCoverageInput {
  readonly left: ManagedMemberInspection;
  readonly right: ManagedMemberInspection;
  readonly leftMethodPage: PageAssessment;
  readonly rightMethodPage: PageAssessment;
  readonly leftFieldPage: PageAssessment;
  readonly rightFieldPage: PageAssessment;
  readonly omittedMethodItems: number;
  readonly omittedFieldItems: number;
  readonly omittedCandidates: number;
}

export const buildComparisonCoverage = ({
  left,
  right,
  leftMethodPage,
  rightMethodPage,
  leftFieldPage,
  rightFieldPage,
  omittedMethodItems,
  omittedFieldItems,
  omittedCandidates,
}: ComparisonCoverageInput): ManagedMemberComparisonResult["coverage"] => {
  const omittedMethods =
    omittedMethodItems +
    leftMethodPage.sourceOmittedCount +
    rightMethodPage.sourceOmittedCount;
  const omittedFields =
    omittedFieldItems +
    leftFieldPage.sourceOmittedCount +
    rightFieldPage.sourceOmittedCount;
  const leftStatus = sideCoverageStatus(
    left,
    leftMethodPage.sourceComplete && leftFieldPage.sourceComplete,
  );
  const rightStatus = sideCoverageStatus(
    right,
    rightMethodPage.sourceComplete && rightFieldPage.sourceComplete,
  );
  const unknownInput =
    left.coverage.state !== "complete" || right.coverage.state !== "complete";
  const truncated = omittedMethods + omittedFields + omittedCandidates > 0;
  return {
    status: unknownInput
      ? "partial"
      : truncated
        ? "truncated"
        : leftStatus === "complete" && rightStatus === "complete"
          ? "complete-within-inputs"
          : "partial",
    left_status: leftStatus,
    right_status: rightStatus,
    omitted_methods: omittedMethods,
    omitted_fields: omittedFields,
    omitted_candidates: omittedCandidates,
  };
};

const sideCoverageStatus = (
  result: ManagedMemberInspection,
  pagesComplete: boolean,
): ManagedMemberComparisonResult["coverage"]["left_status"] =>
  result.coverage.state === "unavailable"
    ? "unavailable"
    : result.coverage.state === "complete" && pagesComplete
      ? "complete"
      : "partial";

export const sideManifest = (
  side: ManagedMemberComparisonSide,
): ManagedMemberComparisonResult["left"] => ({
  evidence_id: side.evidenceId,
  artifact_sha256: side.result.artifact.sha256,
  mvid: side.result.module?.mvid ?? null,
  module_name: side.result.module?.name ?? null,
  metadata_status: side.result.metadata.status,
  methods_total: side.result.methods.total,
  fields_total: side.result.fields.total,
});

export const buildComparisonSummary = (
  items: readonly (
    | ManagedMemberComparisonResult["methods"][number]
    | ManagedMemberComparisonResult["fields"][number]
  )[],
): ManagedMemberComparisonResult["summary"] => ({
  unchanged: items.filter(({ status }) => status === "unchanged").length,
  changed: items.filter(({ status }) => status === "changed").length,
  added: items.filter(({ status }) => status === "added").length,
  removed: items.filter(({ status }) => status === "removed").length,
  unknown: items.filter(({ status }) => status === "unknown").length,
});

export const buildComparisonMatching = (
  methodItems: readonly ManagedMemberComparisonResult["methods"][number][],
  fieldItems: readonly ManagedMemberComparisonResult["fields"][number][],
): ManagedMemberComparisonResult["matching"] => ({
  exact_il_signature: methodItems.filter(
    ({ match }) => match.basis === "exact-il-signature",
  ).length,
  structural_method_shape: methodItems.filter(
    ({ match }) => match.basis === "structural-method-shape",
  ).length,
  field_signature: fieldItems.filter(
    ({ match }) => match.basis === "field-signature",
  ).length,
  ambiguous:
    methodItems.filter(({ match }) => match.status === "ambiguous").length +
    fieldItems.filter(({ match }) => match.status === "ambiguous").length,
  unmatched: [...methodItems, ...fieldItems].filter(
    ({ match }) => match.status === "unmatched",
  ).length,
});

export const comparisonLimitations = (
  left: ManagedMemberInspection,
  right: ManagedMemberInspection,
  omittedItems: number,
  omittedCandidates: number,
): string[] => {
  const limitations: string[] = [
    "Metadata tokens are build-local coordinates; matched pairs are remaps, not persistent identities.",
    "Names are reported as observations but are not used as a matching basis.",
  ];
  if (!left.methods.complete || !right.methods.complete)
    limitations.push("At least one method page is incomplete.");
  if (!left.fields.complete || !right.fields.complete)
    limitations.push("At least one field page is incomplete.");
  if (left.coverage.state !== "complete" || right.coverage.state !== "complete")
    limitations.push("At least one managed member observation is partial.");
  if (omittedItems > 0)
    limitations.push(
      `${String(omittedItems)} comparison items were omitted by output limits.`,
    );
  if (omittedCandidates > 0)
    limitations.push(
      `${String(omittedCandidates)} ambiguous candidates were omitted by candidate limits.`,
    );
  return limitations;
};
