import {
  relationshipCoverageLimitations,
  type RelationshipCoverage,
} from "./relationshipCoverage.js";
import type { FunctionDossier } from "./native/functionDossier.js";
import { uniqueSorted } from "./canonicalOrdering.js";

const callerCoveragePrefix = "Callers: ";
const calleeCoveragePrefix = "Callees: ";

/** Combine caller and callee read outcomes without losing either explanation. */
export const combineFunctionRelationshipCoverage = (
  callers: RelationshipCoverage | undefined,
  callees: RelationshipCoverage | undefined,
): RelationshipCoverage => {
  const reads = [
    { direction: "callers" as const, coverage: callers },
    { direction: "callees" as const, coverage: callees },
  ];
  const diagnostics = uniqueSorted(
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
 * Forward searches depend on callee coverage. Preserve the historical
 * unknown-reason encoding when reading observations without explicit directions.
 */
export const isCallerOnlyIncompleteCoverage = (
  coverage: RelationshipCoverage,
): boolean => {
  if (coverage.status === "complete") return false;
  if (coverage.limited_directions !== undefined)
    return !coverage.limited_directions.some(
      (direction) => direction === "callees",
    );
  return (
    coverage.status === "unknown" &&
    coverage.reason.startsWith(callerCoveragePrefix) &&
    !coverage.reason.includes(calleeCoveragePrefix)
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
}

/** Keep observed-set blockers separate from descriptive provider caveats. */
export const assessFunctionCallCoverage = (
  coverage: RelationshipCoverage | null,
  dossier: Pick<FunctionDossier, "unresolved_calls">,
): FunctionCallCoverageAssessment => {
  const unresolvedCallCaveats = uniqueSorted(
    (dossier.unresolved_calls ?? []).map(
      ({ address, reason }) => `Unresolved call at ${address}: ${reason}`,
    ),
  );
  const missingDiscovery: string[] = [];
  const discoveryLimitations: string[] = [];
  for (const direction of ["callers", "callees"] as const) {
    const discovery = coverage?.discovery?.[direction];
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
    diagnostics: uniqueSorted(coverage?.diagnostics ?? []),
    discoveryLimitations,
  };
};
