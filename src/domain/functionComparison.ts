import { canonicalJson } from "./comparisonSemantics.js";
import { compareUnicodeCodePoints } from "./unicodeCodePointOrder.js";
import { parseFunctionEvidence } from "./functionDossierEvidence.js";
import { functionMatch } from "./functionComparisonNormalization.js";
import {
  functionComparisonResultSchema,
  type FunctionComparisonResult,
} from "./functionComparisonSchemas.js";
import { overallStatus, summarize } from "./functionComparisonResults.js";
import { compareDimensions } from "./functionComparisonDimensions.js";

/** Compare two complete function Evidence records without fuzzy matching. */
export const compareFunctions = (
  leftInput: unknown,
  rightInput: unknown,
): FunctionComparisonResult => {
  const left = parseFunctionEvidence(leftInput);
  const right = parseFunctionEvidence(rightInput);
  const links = [left.evidence.evidence_id, right.evidence.evidence_id];
  const providersDiffer =
    canonicalJson(left.evidence.provider, "Function comparison") !==
    canonicalJson(right.evidence.provider, "Function comparison");
  const dimensions = compareDimensions(left, right, { links, providersDiffer });
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
    ].sort((a, b) => compareUnicodeCodePoints(a, b)),
  });
};
