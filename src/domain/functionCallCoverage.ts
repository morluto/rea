import type { RelationshipCoverage } from "./relationshipCoverage.js";
import type { FunctionDossier } from "./hopperValues.js";
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
    reads.flatMap(({ coverage }) =>
      coverage !== undefined && "diagnostics" in coverage
        ? coverage.diagnostics
        : [],
    ),
  );
  const details = diagnostics.length > 0 ? { diagnostics } : {};
  const reasons = reads.flatMap(({ direction, coverage }) => {
    const label =
      direction === "callers" ? callerCoveragePrefix : calleeCoveragePrefix;
    const limitations =
      coverage === undefined
        ? ["Provider did not report relationship coverage."]
        : coverage.status === "unknown"
          ? [coverage.reason]
          : coverage.status === "partial"
            ? coverage.limitations
            : [];
    return limitations.map((reason) => `${label}${reason}`);
  });
  if (
    reads.some(
      ({ coverage }) => coverage === undefined || coverage.status === "unknown",
    )
  )
    return {
      status: "unknown",
      reason: uniqueSorted(reasons).join(" "),
      ...details,
    };
  if (reasons.length > 0)
    return {
      status: "partial",
      limitations: uniqueSorted(reasons),
      ...details,
    };
  return { status: "complete", ...details };
};

/**
 * Whether combined relationship coverage is unknown only on the caller side.
 * The combine helper above prefixes each direction's reasons, so a reason
 * that carries the caller prefix and no callee prefix records observed
 * callees with unobservable callers. Forward (callee-edge) searches stay
 * exhaustive under that caveat; the caller reason remains a limitation.
 */
export const isCallerOnlyUnknownCoverage = (
  coverage: RelationshipCoverage,
): boolean =>
  coverage.status === "unknown" &&
  coverage.reason.startsWith(callerCoveragePrefix) &&
  !coverage.reason.includes(calleeCoveragePrefix);

/** Explain why two resolved call sets cannot establish call-set equality. */
export const functionCallCoverageLimitations = (
  coverage: RelationshipCoverage | null,
  dossier: Pick<FunctionDossier, "unresolved_calls">,
): string[] => {
  const limitations =
    coverage === null
      ? ["Provider did not report relationship coverage."]
      : coverage.status === "unknown"
        ? [
            coverage.reason,
            ...("diagnostics" in coverage ? coverage.diagnostics : []),
          ]
        : coverage.status === "partial"
          ? [
              ...coverage.limitations,
              ...("diagnostics" in coverage ? coverage.diagnostics : []),
            ]
          : [];
  limitations.push(
    ...(dossier.unresolved_calls ?? []).map(
      ({ address, reason }) => `Unresolved call at ${address}: ${reason}`,
    ),
  );
  return uniqueSorted(limitations);
};
