import { parseFunctionEvidence } from "./functionDossierEvidence.js";
import { functionMatch } from "./functionComparisonNormalization.js";
import {
  functionComparisonResultSchema,
  type FunctionComparisonResult,
} from "./functionComparisonSchemas.js";
import { overallStatus, summarize, canonicalJson } from "./functionComparisonResults.js";
import { compareDimensions } from "./functionComparisonDimensions.js";

export {
  functionComparisonInputSchema,
  functionComparisonResultSchema,
} from "./functionComparisonSchemas.js";

/** Compare two explicit function Evidence page sets without fuzzy matching. */
export const compareFunctions = (
  leftInput: unknown,
  rightInput: unknown,
  offset: number,
  limit: number,
): FunctionComparisonResult => {
  const left = parseFunctionEvidence(leftInput);
  const right = parseFunctionEvidence(rightInput);
  const links = [
    ...left.evidence.map(({ evidence_id: id }) => id),
    ...right.evidence.map(({ evidence_id: id }) => id),
  ];
  const providersDiffer =
    canonicalJson(left.provider) !== canonicalJson(right.provider);
  const dimensions = compareDimensions(left, right, links, providersDiffer);
  const match = functionMatch(left, right);
  const changes = dimensions.filter(({ status }) => status !== "unchanged");
  const page = changes.slice(offset, offset + limit);
  return functionComparisonResultSchema.parse({
    status: overallStatus(dimensions, match.status),
    function_match: match,
    left_subject_sha256: left.subject.digest.sha256,
    right_subject_sha256: right.subject.digest.sha256,
    summary: summarize(dimensions),
    dimensions,
    changes: {
      items: page,
      offset,
      limit,
      total: changes.length,
      next_offset:
        offset + page.length < changes.length ? offset + page.length : null,
    },
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
