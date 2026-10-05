import { canonicalJson } from "./comparisonSemantics.js";
import { parseFunctionEvidence } from "./functionDossierEvidence.js";
import { functionMatch } from "./functionComparisonNormalization.js";
import {
  functionComparisonResultSchema,
  type FunctionComparisonResult,
} from "./functionComparisonSchemas.js";
import { overallStatus, summarize } from "./functionComparisonResults.js";
import { compareDimensions } from "./functionComparisonDimensions.js";

export {
  functionComparisonInputSchema,
  functionComparisonResultSchema,
} from "./functionComparisonSchemas.js";

/** Compare two complete function Evidence records without fuzzy matching. */
export const compareFunctions = (
  leftInput: unknown,
  rightInput: unknown,
): FunctionComparisonResult => {
  const left = parseFunctionEvidence(leftInput);
  const right = parseFunctionEvidence(rightInput);
  const links = [left.evidence[0].evidence_id, right.evidence[0].evidence_id];
  const providersDiffer =
    canonicalJson(left.provider, "Function comparison") !==
    canonicalJson(right.provider, "Function comparison");
  const dimensions = compareDimensions(left, right, links, providersDiffer);
  const match = functionMatch(left, right);
  const changes = dimensions.filter(({ status }) => status !== "unchanged");
  return functionComparisonResultSchema.parse({
    status: overallStatus(dimensions, match.status),
    function_match: match,
    left_subject_sha256: left.subject.digest.sha256,
    right_subject_sha256: right.subject.digest.sha256,
    summary: summarize(dimensions),
    dimensions,
    changes,
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
    ].sort((a, b) => a.localeCompare(b)),
  });
};
