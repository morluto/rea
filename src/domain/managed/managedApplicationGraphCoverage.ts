import { joinCoverageStatus, type CoverageStatus } from "../coverage.js";
import type { ApplicationGraphEvidence } from "../javascript/javascriptApplicationEvidenceSchemas.js";
import {
  managedInspectionCoverage,
  type ManagedArtifactInspection,
  type ManagedInspectionState,
  type ManagedMemberInspection,
  type ManagedNativeBoundaryInspection,
} from "./managedArtifact.js";
import { managedTokenScopesMatch } from "./managedInspectionEvidence.js";

/** Why a call site did not become a `calls` edge. */
export type OmittedCallReason =
  | "member-ref"
  | "method-spec"
  | "unknown-target"
  | "method-reference"
  | "absent-node"
  | "self-call";

/** Why a field-access site did not become an `accesses` edge. */
export type OmittedFieldAccessReason = "member-ref" | "absent-node";

/** Member-Evidence sites the projection counted but did not turn into edges. */
export interface ManagedRelationOmissions {
  readonly callSites: Readonly<Record<OmittedCallReason, number>>;
  readonly fieldAccessSites: Readonly<Record<OmittedFieldAccessReason, number>>;
}

/** Total sites counted but not projected. */
export const omittedRelationSites = (
  omissions: ManagedRelationOmissions | null,
): number =>
  omissions === null
    ? 0
    : [
        ...Object.values(omissions.callSites),
        ...Object.values(omissions.fieldAccessSites),
      ].reduce((total, count) => total + count, 0);

/** Source observations used to derive managed graph coverage. */
export interface ManagedGraphCoverageSources {
  readonly artifact: ManagedArtifactInspection | null;
  readonly members: ManagedMemberInspection | null;
  readonly boundaries: ManagedNativeBoundaryInspection | null;
}

/** What the supplied sources and the projection left out. */
export interface ManagedGraphProjectionOmissions {
  /** Parser states of the supplied sources; absent sources are not listed. */
  readonly inputStates: readonly ManagedInspectionState[];
  readonly unscopedTokenRelationships: boolean;
  /** Declaring types the member Evidence selected; null when it inspected every type. */
  readonly selectedTypes: readonly string[] | null;
  /** Undefined when all MethodDef rows were examined or member Evidence is absent. */
  readonly methodRows: ManagedMemberInspection["method_rows"] | undefined;
  /** Counted call and field-access sites without edges; null without member Evidence. */
  readonly relations: ManagedRelationOmissions | null;
}

/**
 * Coverage the supplied sources allow: an unavailable source examined nothing,
 * so the graph cannot tell what it omits, even beside a known gap.
 */
const inputCoverage = (
  omissions: ManagedGraphProjectionOmissions,
): CoverageStatus =>
  joinCoverageStatus([
    "complete",
    ...omissions.inputStates.map(managedInspectionCoverage),
  ]);

/** Omissions whose size is unknown, unlike counted relation sites. */
const omitsUncounted = (omissions: ManagedGraphProjectionOmissions): boolean =>
  inputCoverage(omissions) !== "complete" ||
  omissions.unscopedTokenRelationships ||
  omissions.selectedTypes !== null ||
  omissions.methodRows !== undefined;

const omitsAny = (omissions: ManagedGraphProjectionOmissions): boolean =>
  omitsUncounted(omissions) || omittedRelationSites(omissions.relations) > 0;

const completeCoverage = (): ApplicationGraphEvidence["coverage"] => ({
  status: "complete",
  truncated: false,
  omitted_count: 0,
  limits: [],
});

/** Preserve the source parser's coverage state on projected observations. */
export const managedSourceCoverage = (
  state: ManagedInspectionState,
): ApplicationGraphEvidence["coverage"] =>
  state === "complete"
    ? completeCoverage()
    : {
        status: state,
        truncated: false,
        omitted_count: null,
        limits: [],
      };

/** Determine whether any supplied managed inspection was partial. */
export const assessManagedGraphOmissions = (
  sources: ManagedGraphCoverageSources,
  relations: ManagedRelationOmissions | null,
): ManagedGraphProjectionOmissions => ({
  relations,
  unscopedTokenRelationships:
    sources.members !== null &&
    sources.boundaries !== null &&
    (sources.boundaries.pinvoke_imports.some(
      ({ member_token }) => member_token !== null,
    ) ||
      sources.boundaries.native_implementations.length > 0) &&
    !managedTokenScopesMatch(
      sources.members.identity_scope.requires_mvid,
      sources.boundaries.identity_scope.requires_mvid,
    ),
  inputStates: [sources.members, sources.boundaries, sources.artifact].flatMap(
    (source) => (source === null ? [] : [source.coverage.state]),
  ),
  selectedTypes: sources.members?.selection?.type_names ?? null,
  methodRows:
    sources.members === null ||
    (sources.members.method_rows !== null &&
      sources.members.method_rows.offset === 0 &&
      sources.members.method_rows.count === sources.members.method_rows.total)
      ? undefined
      : sources.members.method_rows,
});

/** Derive graph coverage solely from the coverage of supplied source evidence. */
export const managedGraphEvidenceCoverage = (
  omissions: ManagedGraphProjectionOmissions,
): ApplicationGraphEvidence["coverage"] =>
  inputCoverage(omissions) === "unknown"
    ? { status: "unknown", truncated: false, omitted_count: null, limits: [] }
    : omitsAny(omissions)
      ? {
          status: "partial",
          truncated: false,
          omitted_count: omitsUncounted(omissions)
            ? null
            : omittedRelationSites(omissions.relations),
          limits: [],
        }
      : completeCoverage();

/** Report whether all supplied source evidence was complete. */
export const managedGraphResultCoverage = (
  omissions: ManagedGraphProjectionOmissions,
) => ({
  status:
    inputCoverage(omissions) === "unknown"
      ? ("unknown" as const)
      : omitsAny(omissions)
        ? ("partial" as const)
        : ("complete-within-inputs" as const),
});
