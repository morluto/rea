import {
  artifactComparisonResultSchema,
  type ArtifactComparisonResult,
} from "./artifactComparison.js";
import type { ComparisonEvidenceOperation } from "./comparisonEvidenceIdentity.js";
import type { Evidence } from "./evidence.js";
import { EvidenceIntegrityError } from "./evidenceErrors.js";
import { readEvidencePayload } from "./evidenceValidation.js";
import { functionComparisonFindingLinks } from "./functionComparisonResults.js";
import {
  functionComparisonResultSchema,
  type FunctionComparisonResult,
} from "./functionComparisonSchemas.js";
import {
  processCaptureComparisonSchema,
  type ProcessCaptureComparison,
} from "./process/processComparison.js";
import { err, ok, type Result } from "./result.js";

type ComparisonResults = {
  readonly compare_artifacts: ArtifactComparisonResult;
  readonly compare_functions: FunctionComparisonResult;
  readonly compare_process_captures: ProcessCaptureComparison;
};

/** One admitted comparison's envelope and its operation-specific parsed facts. */
export type ParsedComparisonEvidence<
  Operation extends ComparisonEvidenceOperation = ComparisonEvidenceOperation,
> = {
  [Kind in Operation]: {
    readonly operation: Kind;
    readonly evidence: Evidence;
    readonly result: ComparisonResults[Kind];
  };
}[Operation];

/** Decode an admitted comparison's payload and validate nested finding citations. */
export function readComparisonResult<
  Operation extends ComparisonEvidenceOperation,
>(
  evidence: Evidence,
  operation: Operation,
): Result<ParsedComparisonEvidence<Operation>, EvidenceIntegrityError>;
export function readComparisonResult(
  evidence: Evidence,
  operation: ComparisonEvidenceOperation,
): Result<ParsedComparisonEvidence, EvidenceIntegrityError> {
  if (operation === "compare_process_captures") {
    const parsed = readEvidencePayload(
      processCaptureComparisonSchema,
      evidence.normalized_result,
    );
    if (!parsed.ok) return parsed;
    return ok({ operation, evidence, result: parsed.value });
  }
  if (operation === "compare_functions") {
    const parsed = readEvidencePayload(
      functionComparisonResultSchema,
      evidence.normalized_result,
    );
    if (!parsed.ok) return parsed;
    const optIn = validateNormalizedViewOptIn(evidence, parsed.value);
    if (!optIn.ok) return optIn;
    const links = validateFindingLinks(
      evidence,
      functionComparisonFindingLinks(parsed.value),
    );
    if (!links.ok) return links;
    const sources = validateNormalizedViewSources(evidence, parsed.value);
    if (!sources.ok) return sources;
    return ok({ operation, evidence, result: parsed.value });
  }
  const parsed = readEvidencePayload(
    artifactComparisonResultSchema,
    evidence.normalized_result,
  );
  if (!parsed.ok) return parsed;
  const links = validateFindingLinks(
    evidence,
    parsed.value.changes.flatMap(({ evidence_links }) => evidence_links),
  );
  if (!links.ok) return links;
  return ok({ operation, evidence, result: parsed.value });
}

/** The recorded caller opt-in, not the payload, decides whether views exist. */
const validateNormalizedViewOptIn = (
  evidence: Evidence,
  result: FunctionComparisonResult,
): Result<void, EvidenceIntegrityError> =>
  (evidence.parameters["include_normalized_views"] === true) ===
  (result.normalized_views !== undefined)
    ? ok(undefined)
    : err(
        new EvidenceIntegrityError(
          "Function comparison normalized views disagree with the recorded include_normalized_views selection",
        ),
      );

/** Each normalized view must cite both recorded source selections. */
const validateNormalizedViewSources = (
  evidence: Evidence,
  result: FunctionComparisonResult,
): Result<void, EvidenceIntegrityError> => {
  const sources = [
    evidence.parameters["left_evidence_id"],
    evidence.parameters["right_evidence_id"],
  ];
  return (result.normalized_views?.views ?? []).every(({ evidence_links }) =>
    sources.every(
      (source) => typeof source === "string" && evidence_links.includes(source),
    ),
  )
    ? ok(undefined)
    : err(
        new EvidenceIntegrityError(
          "Function comparison normalized views must cite both selected source Evidence records",
        ),
      );
};

const validateFindingLinks = (
  evidence: Evidence,
  nestedLinks: readonly string[],
): Result<void, EvidenceIntegrityError> => {
  const closure = new Set(evidence.evidence_links);
  return nestedLinks.some((id) => !closure.has(id))
    ? err(
        new EvidenceIntegrityError(
          "Comparison finding cites Evidence outside its top-level closure",
        ),
      )
    : ok(undefined);
};
