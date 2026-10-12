import type {
  ManagedMemberComparisonResult,
  ManagedMemberComparisonSide,
} from "./managedMemberComparison.js";
import type { ManagedMemberInspection } from "./managedArtifact.js";

interface ComparisonCoverageInput {
  readonly left: ManagedMemberInspection;
  readonly right: ManagedMemberInspection;
}

export const buildComparisonCoverage = ({
  left,
  right,
}: ComparisonCoverageInput): ManagedMemberComparisonResult["coverage"] => {
  const leftStatus = sideCoverageStatus(left);
  const rightStatus = sideCoverageStatus(right);
  const unknownInput =
    left.coverage.state !== "complete" ||
    right.coverage.state !== "complete" ||
    !sameSelection(left, right);
  return {
    status:
      !unknownInput && leftStatus === "complete" && rightStatus === "complete"
        ? "complete-within-inputs"
        : "partial",
    left_status: leftStatus,
    right_status: rightStatus,
  };
};

/** Whether both observations inspected the same declaring types. */
const sameSelection = (
  left: ManagedMemberInspection,
  right: ManagedMemberInspection,
): boolean => {
  if (left.selection === null || right.selection === null)
    return left.selection === right.selection;
  const rightNames = new Set(right.selection.type_names);
  return (
    rightNames.size === new Set(left.selection.type_names).size &&
    left.selection.type_names.every((name) => rightNames.has(name))
  );
};

const sideCoverageStatus = (
  result: ManagedMemberInspection,
): ManagedMemberComparisonResult["coverage"]["left_status"] =>
  result.coverage.state === "unavailable"
    ? "unavailable"
    : result.coverage.state === "complete"
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
  methods_total: side.result.methods.length,
  fields_total: side.result.fields.length,
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
  exact_signature: [...methodItems, ...fieldItems].filter(
    ({ match }) => match.basis === "exact-signature",
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
): string[] => {
  const limitations: string[] = [
    "Metadata tokens are build-local coordinates; matched pairs are remaps, not persistent identities.",
    "Methods pair by exact CIL/signature, then declared type, name, and signature, then structural shape; names alone are never a matching basis.",
    "Fields pair by exact signature, then declared type, name, and signature; an undecoded signature is compared only by its raw bytes, and an unmatched member with one stays unknown.",
  ];
  if (left.coverage.state !== "complete" || right.coverage.state !== "complete")
    limitations.push("At least one managed member observation is partial.");
  if (!sameSelection(left, right))
    limitations.push(
      "The observations select different declaring types; a member outside the other side's selection is unknown, not added or removed.",
    );
  else if (left.selection !== null)
    limitations.push(
      `Both observations cover only the selected declaring types (${left.selection.type_names.join(", ")}); member totals and statuses describe those types, not the whole assembly.`,
    );
  if (left.exported_types === null || right.exported_types === null)
    limitations.push(
      "At least one managed member observation predates ExportedType inspection; its exported and forwarded types are unknown.",
    );
  if (
    (left.exported_types?.length ?? 0) > 0 ||
    (right.exported_types?.length ?? 0) > 0
  )
    limitations.push(
      "ExportedType rows, including type forwarders, are observed but not compared; an unchanged comparison does not establish an unchanged exported or forwarded type set.",
    );
  return limitations;
};
