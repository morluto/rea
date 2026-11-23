import { managedModuleRow } from "./managedModuleIdentity.js";
import { joinCoverageStatus, type CoverageStatus } from "../coverage.js";
import type {
  ManagedMemberComparisonResult,
  ManagedMemberComparisonSide,
} from "./managedMemberComparison.js";
import {
  managedInspectionCoverage,
  type ManagedMemberInspection,
} from "./managedArtifact.js";

interface ComparisonCoverageInput {
  readonly left: ManagedMemberInspection;
  readonly right: ManagedMemberInspection;
  readonly scope: ManagedComparisonScope;
}

type SelectionAgreement = "same" | "different" | "unknown";

export const buildComparisonCoverage = ({
  left,
  right,
  scope,
}: ComparisonCoverageInput): ManagedMemberComparisonResult["coverage"] => {
  // An unavailable side examined nothing, and an unknown selection agreement
  // cannot tell whether both sides cover the same types: either makes the
  // comparison unknown, even beside a known gap.
  const joined = joinCoverageStatus([
    managedInspectionCoverage(left.coverage.state),
    managedInspectionCoverage(right.coverage.state),
    scope.left.hasEmptyDefinitionName || scope.right.hasEmptyDefinitionName
      ? "partial"
      : "complete",
    scope.agreement === "unknown"
      ? "unknown"
      : scope.agreement === "different" || !sameMethodRows(left, right)
        ? "partial"
        : "complete",
  ]);
  return {
    status: joined === "complete" ? "complete-within-inputs" : joined,
    left_status: left.coverage.state,
    right_status: right.coverage.state,
  };
};

/** Full MethodDef coverage is required before inferring cross-build absence. */
export const hasCompleteMethodRows = (
  result: ManagedMemberInspection,
): boolean =>
  result.method_rows !== null &&
  result.method_rows.offset === 0 &&
  result.method_rows.count === result.method_rows.total;

const sameMethodRows = (
  left: ManagedMemberInspection,
  right: ManagedMemberInspection,
): boolean =>
  (hasCompleteMethodRows(left) && hasCompleteMethodRows(right)) ||
  (left.method_rows !== null &&
    right.method_rows !== null &&
    left.method_rows.offset === right.method_rows.offset &&
    left.method_rows.count === right.method_rows.count &&
    left.method_rows.total === right.method_rows.total);

/** An empty recorded name also invalidates digests framed by that enclosing name. */
const unavailableTypeNames = (
  types: ManagedMemberInspection["types"],
): ReadonlySet<string> => {
  const unavailable = new Set(
    types.filter(({ name }) => name === "").map(({ token }) => token),
  );
  if (unavailable.size === 0) return unavailable;
  const children = new Map<string, string[]>();
  for (const { token, enclosing_type_token: enclosing } of types) {
    if (enclosing === null) continue;
    const existing = children.get(enclosing);
    if (existing === undefined) children.set(enclosing, [token]);
    else existing.push(token);
  }
  // A Set visits appended entries and prevents cyclic historical links from
  // revisiting a row. Follow only enclosing links retained in the report.
  for (const token of unavailable)
    for (const child of children.get(token) ?? []) unavailable.add(child);
  return unavailable;
};

/** One side's nominal name availability and observed declaring-type selection. */
const comparisonSideScope = (result: ManagedMemberInspection) => {
  const unavailable = unavailableTypeNames(result.types);
  const names = new Map(
    result.types.map((type) => [
      type.token,
      unavailable.has(type.token) ? null : type.name_sha256,
    ]),
  );
  // Historical Evidence may record invalid names with complete coverage.
  const hasEmptyTypeName = unavailable.size > 0;
  const emptyMemberNames = new Set<DeclaredMember>();
  for (const definitions of [result.methods, result.fields])
    for (const member of definitions)
      if (member.name === "") emptyMemberNames.add(member);
  const emptyFieldTokens = new Set(
    result.fields
      .filter((field) => emptyMemberNames.has(field))
      .map(({ token }) => token),
  );
  // A selected method can reference a Field row outside the retained inventory.
  for (const access of result.field_accesses)
    if (access.field_name === "" && access.field_token.startsWith("0x04"))
      emptyFieldTokens.add(access.field_token);
  const hasEmptyDefinitionName =
    hasEmptyTypeName || emptyMemberNames.size > 0 || emptyFieldTokens.size > 0;
  const metadataComplete =
    result.metadata.status === "complete" && !hasEmptyDefinitionName;
  return {
    names,
    emptyMemberNames,
    emptyFieldTokens,
    hasEmptyDefinitionName,
    metadataComplete,
    selected:
      result.selection === null
        ? null
        : new Set([...names.values()].filter((name) => name !== null)),
    complete:
      result.coverage.state === "complete" &&
      result.metadata.status === "complete" &&
      !hasEmptyTypeName &&
      result.types.every(({ name_sha256 }) => name_sha256 !== null),
  };
};

type ComparisonSideScope = ReturnType<typeof comparisonSideScope>;
type DeclaredMember =
  | ManagedMemberInspection["methods"][number]
  | ManagedMemberInspection["fields"][number];

/** Resolve tokens only in their own source, then test opposite nominal scope. */
const observedBy = (
  own: ComparisonSideScope,
  opposite: ComparisonSideScope,
  member: DeclaredMember,
): boolean => {
  if (opposite.selected === null) return true;
  const name = own.names.get(member.declaring_type_token ?? "");
  return name != null && opposite.selected.has(name);
};

/** Compare the nominal types the owner retained, independently of request spelling. */
const compareSelectedTypes = (
  left: ComparisonSideScope,
  right: ComparisonSideScope,
): SelectionAgreement => {
  const leftNames = left.selected;
  const rightNames = right.selected;
  if (leftNames === null || rightNames === null)
    return leftNames === rightNames ? "same" : "different";
  if (!left.complete || !right.complete) return "unknown";
  return leftNames.size === rightNames.size &&
    [...leftNames].every((name) => rightNames.has(name))
    ? "same"
    : "different";
};

/** Share the same nominal facts across pairing, absence and scope agreement. */
export const managedComparisonScope = (
  left: ManagedMemberInspection,
  right: ManagedMemberInspection,
) => {
  const a = comparisonSideScope(left);
  const b = comparisonSideScope(right);
  return {
    left: a,
    right: b,
    inLeft: (member: DeclaredMember) => observedBy(b, a, member),
    inRight: (member: DeclaredMember) => observedBy(a, b, member),
    agreement: compareSelectedTypes(a, b),
  };
};

export type ManagedComparisonScope = ReturnType<typeof managedComparisonScope>;

/** Copy the source's typed capacity facts without retaining unrelated issue inventories. */
const resourceLimits = (
  result: ManagedMemberInspection,
): NonNullable<ManagedMemberComparisonResult["left"]["resource_limits"]> =>
  result.coverage.issues.flatMap(({ code, scope, detail, offset, limit }) =>
    code === "resource-limit"
      ? [
          {
            code,
            scope,
            detail,
            offset,
            ...(limit === undefined ? {} : { limit }),
          },
        ]
      : [],
  );

export const sideManifest = (
  side: ManagedMemberComparisonSide,
): ManagedMemberComparisonResult["left"] => {
  const module = managedModuleRow(side.result);
  return {
    evidence_id: side.evidenceId,
    artifact_sha256: side.result.artifact.sha256,
    mvid: module?.mvid ?? null,
    module_name: module?.name ?? null,
    metadata_status: side.result.metadata.status,
    methods_total: side.result.methods.length,
    fields_total: side.result.fields.length,
    resource_limits: resourceLimits(side.result),
  };
};

export const buildComparisonSummary = (
  items: readonly (
    | ManagedMemberComparisonResult["methods"][number]
    | ManagedMemberComparisonResult["fields"][number]
  )[],
): ManagedMemberComparisonResult["summary"] => {
  const counts = {
    unchanged: 0,
    changed: 0,
    added: 0,
    removed: 0,
    unknown: 0,
  };
  for (const { status } of items) counts[status] += 1;
  return counts;
};

export const buildComparisonMatching = (
  methodItems: readonly ManagedMemberComparisonResult["methods"][number][],
  fieldItems: readonly ManagedMemberComparisonResult["fields"][number][],
): ManagedMemberComparisonResult["matching"] => {
  const counts = {
    exact_il_signature: 0,
    exact_signature: 0,
    structural_method_shape: 0,
    field_signature: 0,
    ambiguous: 0,
    unmatched: 0,
  };
  for (const { match } of methodItems) {
    if (match.basis === "exact-il-signature") counts.exact_il_signature += 1;
    else if (match.basis === "exact-signature") counts.exact_signature += 1;
    else if (match.basis === "structural-method-shape")
      counts.structural_method_shape += 1;
    if (match.status === "ambiguous") counts.ambiguous += 1;
    else if (match.status === "unmatched") counts.unmatched += 1;
  }
  for (const { match } of fieldItems) {
    if (match.basis === "exact-signature") counts.exact_signature += 1;
    else if (match.basis === "field-signature") counts.field_signature += 1;
    if (match.status === "ambiguous") counts.ambiguous += 1;
    else if (match.status === "unmatched") counts.unmatched += 1;
  }
  return counts;
};

/** Carry each side's representation-budget diagnostic and its recovery. */
const capacityLimitations = (
  left: ManagedMemberInspection,
  right: ManagedMemberInspection,
): string[] => {
  const exceeded = new Set(
    (["left", "right"] as const).flatMap((side) =>
      resourceLimits(side === "left" ? left : right).map(
        ({ scope, detail }) =>
          `The ${side} managed member observation exceeded capacity at ${scope}: ${detail}. Its member collections are not examined to completion, so empty or missing members do not establish absence, addition or removal.`,
      ),
    ),
  );
  return exceeded.size === 0
    ? []
    : [
        ...exceeded,
        "Compare a smaller selection by inspecting both sides with the same type_names, or by passing --type to CLI compare-managed-members; a single selected type can still exceed capacity.",
      ];
};

export const comparisonLimitations = (
  left: ManagedMemberInspection,
  right: ManagedMemberInspection,
  scope = managedComparisonScope(left, right),
): string[] => {
  const limitations: string[] = [
    "Metadata tokens are build-local coordinates; matched pairs are remaps, not persistent identities.",
    "Methods pair within one declared type and name by exact CIL/signature, then signature, then structural shape; only then may exact CIL/signature or structural shape alone remap across declared types or names, never taking a member whose own declared type and name remain unpaired on the other side or whose declaring type is unresolved. Names alone are never a matching basis.",
    "Fields pair by declared type, name, and signature, then remap by exact decoded signature alone under the same rule; an undecoded signature is compared only for an exact signature match, and an unmatched member with one stays unknown.",
  ];
  if (
    [left, right].some((report) =>
      report.fields.some((field) => field.constant != null),
    )
  )
    limitations.push(
      "Field Constant-table defaults are not compared; field matching and change detection cover names, flags and signatures only.",
    );
  const namesTypes = (result: ManagedMemberInspection) =>
    result.methods.some(
      ({ signature }) =>
        signature.resolved_sha256 !== null &&
        signature.resolved_sha256 !== signature.raw_sha256,
    ) ||
    result.fields.some(
      ({ signature }) =>
        signature.resolved_sha256 !== null &&
        signature.resolved_sha256 !== signature.raw_sha256,
    );
  if (namesTypes(left) || namesTypes(right))
    limitations.push(
      "Signature type operands compare by namespace, name, and enclosing names only; defining assemblies and CLR type identity are not established by this comparison.",
    );
  if (left.coverage.state !== "complete" || right.coverage.state !== "complete")
    limitations.push("At least one managed member observation is partial.");
  if (scope.left.hasEmptyDefinitionName || scope.right.hasEmptyDefinitionName)
    limitations.push(
      "Recorded empty definition names leave nominal identities unresolved. The comparison has partial name coverage even if a source reported complete metadata.",
    );
  for (const limitation of capacityLimitations(left, right))
    limitations.push(limitation);
  if (scope.agreement === "different")
    limitations.push(
      "The observations select different declaring types; a member outside the other side's selection is unknown, not added or removed.",
    );
  else if (scope.agreement === "unknown")
    limitations.push(
      "Selected declaring-type scope agreement is unknown because at least one observation is incomplete or lacks resolved nominal type identities; matching request names do not establish the same observed scope.",
    );
  else if (left.selection !== null && left.types.length === 0)
    limitations.push(
      "Both observations select no observed declaring types; requested and unmatched names remain in each source selection.",
    );
  else if (left.selection !== null)
    limitations.push(
      `Both observations cover only the selected declaring types (${[...new Set(left.types.map(({ full_name }) => full_name))].join(", ")}); member totals and statuses describe those types, not the whole assembly.`,
    );
  if (!hasCompleteMethodRows(left) || !hasCompleteMethodRows(right))
    limitations.push(
      "At least one observation lacks a complete MethodDef row inventory; paged or unrecorded method scope cannot establish cross-build method absence. Row intervals are reported in method_rows and describe build-local selections.",
    );
  if (left.exported_types === null || right.exported_types === null)
    limitations.push(
      "At least one managed member observation did not examine ExportedType rows; its exported and forwarded types are unknown.",
    );
  if (
    // optional-fact-default: null rows are reported as unknown by the limitation above.
    (left.exported_types?.length ?? 0) > 0 ||
    // optional-fact-default: null rows are reported as unknown by the limitation above.
    (right.exported_types?.length ?? 0) > 0
  )
    limitations.push(
      "ExportedType rows, including type forwarders, are observed but not compared; an unchanged comparison does not establish an unchanged exported or forwarded type set.",
    );
  limitations.push(
    "ldstr literals are not compared; normalized CIL keeps #US tokens rather than decoded text, so an unchanged method does not establish unchanged string literals.",
  );
  return limitations;
};
