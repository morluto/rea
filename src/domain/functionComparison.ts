import { canonicalJson } from "./comparisonSemantics.js";
import { compareUnicodeCodePoints } from "./unicodeCodePointOrder.js";
import {
  functionSnapshotCoordinateContext,
  type FunctionSnapshot,
} from "./functionDossierEvidence.js";
import { functionMatch } from "./functionComparisonNormalization.js";
import {
  functionComparisonResultSchema,
  type FunctionComparisonResult,
} from "./functionComparisonSchemas.js";
import { overallStatus, summarize } from "./functionComparisonResults.js";
import { compareDimensions } from "./functionComparisonDimensions.js";
import { normalizedViews } from "./functionComparisonNormalizedViews.js";

/** Caller-selected projection options for one explicit comparison. */
export interface FunctionComparisonRequest {
  readonly includeNormalizedViews?: boolean;
  /** Named-symbol work allowance per side; omitted keeps the default. */
  readonly maxNamedSymbolCodeUnits?: number;
}

/** Compare two authenticated function snapshots without fuzzy matching. */
export const compareFunctions = (
  left: FunctionSnapshot,
  right: FunctionSnapshot,
  request: FunctionComparisonRequest = {},
): FunctionComparisonResult => {
  const links = [left.evidence.evidence_id, right.evidence.evidence_id];
  const providersDiffer =
    canonicalJson(left.evidence.provider, "Function comparison") !==
    canonicalJson(right.evidence.provider, "Function comparison");
  const coordinateContext = functionSnapshotCoordinateContext(left, right);
  const match = functionMatch(left, right, coordinateContext);
  const dimensions = compareDimensions(left, right, {
    links,
    providersDiffer,
    sameIdentity:
      match.method === "same-entry" || match.method === "same-evidence",
    coordinateContext,
  });
  const changes = dimensions.filter(({ status }) => status !== "unchanged");
  return functionComparisonResultSchema.parse({
    status: overallStatus(dimensions, match.status),
    function_match: match,
    left_subject_sha256: left.target.sha256,
    right_subject_sha256: right.target.sha256,
    summary: summarize(dimensions),
    dimensions,
    changes,
    ...(request.includeNormalizedViews === true
      ? {
          normalized_views: normalizedViews(left, right, {
            links,
            providersDiffer,
            // A coordinate commitment can match one record as same-entry first.
            sameEvidence: links[0] === links[1],
            ...(request.maxNamedSymbolCodeUnits === undefined
              ? {}
              : { namedSymbolCodeUnits: request.maxNamedSymbolCodeUnits }),
            callsStatus:
              dimensions.find(({ dimension }) => dimension === "calls")
                ?.status ?? "unknown",
          }),
        }
      : {}),
    limitations: [
      ...new Set([
        ...left.limitations.map((item) => `Left: ${item}`),
        ...right.limitations.map((item) => `Right: ${item}`),
        ...(providersDiffer
          ? [
              "Provider-specific pseudocode and assembly representations were not equated.",
            ]
          : []),
      ]),
    ].sort((a, b) => compareUnicodeCodePoints(a, b)),
  });
};
