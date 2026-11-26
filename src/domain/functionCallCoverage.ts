import {
  relationshipCoverageLimitations,
  type EvidenceRelationshipCoverage,
  type RelationshipCoverage,
  type RelationshipDiscoveryStatus,
} from "./relationshipCoverage.js";
import type { FunctionDossier } from "./native/functionDossier.js";
import { uniqueSorted } from "./canonicalOrdering.js";

const callerCoveragePrefix = "Callers: ";
const calleeCoveragePrefix = "Callees: ";

/** Combine caller and callee read outcomes without losing either explanation. */
export const combineFunctionRelationshipCoverage = (
  callers: EvidenceRelationshipCoverage | undefined,
  callees: EvidenceRelationshipCoverage | undefined,
): RelationshipCoverage => {
  const reads = [
    { direction: "callers" as const, coverage: callers },
    { direction: "callees" as const, coverage: callees },
  ];
  const diagnostics = uniqueSorted(
    // optional-fact-default: descriptive caveats; discovery status carries completeness.
    reads.flatMap(({ coverage }) => coverage?.diagnostics ?? []),
  );
  const discovery = {
    ...(callers?.discovery?.callers === undefined
      ? {}
      : { callers: callers.discovery.callers }),
    ...(callees?.discovery?.callees === undefined
      ? {}
      : { callees: callees.discovery.callees }),
  };
  const details = {
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
    ...(Object.keys(discovery).length === 0 ? {} : { discovery }),
  };
  const callersLimited = callers?.status !== "complete";
  const calleesLimited = callees?.status !== "complete";
  const limited_directions: Extract<
    RelationshipCoverage,
    { status: "partial" }
  >["limited_directions"] = callersLimited
    ? calleesLimited
      ? ["callers", "callees"]
      : ["callers"]
    : ["callees"];
  const reasons = reads.flatMap(({ direction, coverage }) => {
    const label =
      direction === "callers" ? callerCoveragePrefix : calleeCoveragePrefix;
    return relationshipCoverageLimitations(coverage).map(
      (reason) => `${label}${reason}`,
    );
  });
  if (
    reads.some(
      ({ coverage }) => coverage === undefined || coverage.status === "unknown",
    )
  )
    return {
      status: "unknown",
      reason: uniqueSorted(reasons).join(" "),
      limited_directions,
      ...details,
    };
  if (reasons.length > 0)
    return {
      status: "partial",
      limitations: uniqueSorted(reasons),
      limited_directions,
      ...details,
    };
  return { status: "complete", ...details };
};

/**
 * Forward searches depend on callee coverage. Historical format-2 records that
 * omitted `limited_directions` fail closed (never treated as caller-only).
 */
export const isCallerOnlyIncompleteCoverage = (
  coverage: EvidenceRelationshipCoverage,
): boolean => {
  if (coverage.status === "complete") return false;
  if (coverage.limited_directions === undefined) return false;
  return !coverage.limited_directions.some(
    (direction) => direction === "callees",
  );
};

export interface FunctionCallCoverageAssessment {
  /** Reasons the observed call sets cannot establish equality. */
  readonly blockers: readonly string[];
  /** Explicit unresolved outgoing calls, kept separate for forward searches. */
  readonly unresolvedCallCaveats: readonly string[];
  /** Provider caveats that remain relevant even with complete coverage. */
  readonly diagnostics: readonly string[];
  /** Discovery limits do not invalidate comparisons of the observed sets. */
  readonly discoveryLimitations: readonly string[];
  /** Whether all requested call discovery directions are established. */
  readonly discoveryStatus: RelationshipDiscoveryStatus;
}

/** Keep observed-set blockers separate from descriptive provider caveats. */
export const assessFunctionCallCoverage = (
  coverage: EvidenceRelationshipCoverage | null,
  dossier: Pick<FunctionDossier, "unresolved_calls">,
): FunctionCallCoverageAssessment => {
  const unresolvedCallCaveats = uniqueSorted(
    // optional-fact-default: caveat text only; discoveryStatus carries completeness.
    (dossier.unresolved_calls ?? []).map(
      ({ address, reason }) => `Unresolved call at ${address}: ${reason}`,
    ),
  );
  const missingDiscovery: string[] = [];
  const discoveryLimitations: string[] = [];
  let discoveryStatus: RelationshipDiscoveryStatus = "complete";
  for (const direction of ["callers", "callees"] as const) {
    const discovery = coverage?.discovery?.[direction];
    if (discovery?.status === "partial") discoveryStatus = "partial";
    else if (discovery?.status !== "complete" && discoveryStatus !== "partial")
      discoveryStatus = "unknown";
    if (discovery?.status === "complete") continue;
    if (discovery?.reason === undefined) missingDiscovery.push(direction);
    else
      discoveryLimitations.push(
        `Static direct-call discovery for ${direction} is ${discovery.status}: ${discovery.reason}`,
      );
  }
  if (missingDiscovery.length > 0)
    discoveryLimitations.push(
      `Static direct-call discovery is not established for ${missingDiscovery.join(" and ")}.`,
    );
  return {
    blockers: uniqueSorted([
      ...relationshipCoverageLimitations(coverage),
      ...unresolvedCallCaveats,
    ]),
    unresolvedCallCaveats,
    // optional-fact-default: descriptive caveats; discoveryStatus carries completeness.
    diagnostics: uniqueSorted(coverage?.diagnostics ?? []),
    discoveryLimitations,
    discoveryStatus,
  };
};
