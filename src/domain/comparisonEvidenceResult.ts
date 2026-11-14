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
import { comparisonSourceEvidenceSides } from "./comparisonSourceEvidence.js";

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
    if (parsed.value.function_match.method === "same-evidence") {
      try {
        const { left, right } = comparisonSourceEvidenceSides(evidence);
        const sourceId = left[0];
        // Normalized views project the same source, so they share its invariants.
        const conclusions = [
          ...parsed.value.dimensions,
          ...(parsed.value.normalized_views?.views ?? []),
        ];
        const sameSource =
          left.length === 1 &&
          right.length === 1 &&
          sourceId === right[0] &&
          sourceId !== undefined &&
          evidence.evidence_links.includes(sourceId) &&
          conclusions.every(({ evidence_links }) =>
            evidence_links.every((id) => id === sourceId),
          );
        const impossibleChange =
          parsed.value.left_subject_sha256 !==
            parsed.value.right_subject_sha256 ||
          conclusions.some(
            (dimension) =>
              dimension.status === "changed" ||
              (dimension.status === "unchanged" &&
                dimension.left_digest !== dimension.right_digest),
          ) ||
          (parsed.value.normalized_views?.views ?? []).some(
            (view) => !sameProjectedFacts(view),
          );
        if (!sameSource || impossibleChange)
          return err(
            new EvidenceIntegrityError(
              "Same-Evidence function comparison must cite the same source on both sides",
            ),
          );
      } catch (cause) {
        if (cause instanceof EvidenceIntegrityError) return err(cause);
        throw cause;
      }
    }
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
  const links = validateFindingLinks(evidence, [
    ...parsed.value.changes.flatMap(({ evidence_links }) => evidence_links),
    ...(parsed.value.integrity_mismatch_evidence_ids ?? []),
  ]);
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

type NormalizedView = NonNullable<
  FunctionComparisonResult["normalized_views"]
>["views"][number];

/** One source projects the same facts on both sides, whatever a view concludes. */
const sameProjectedFacts = (view: NormalizedView): boolean =>
  view.left_digest === view.right_digest &&
  view.left_count === view.right_count &&
  (view.masking === null ||
    (
      [
        "address_derived_identifiers",
        "unmasked_address_derived_identifiers",
        "corroborated_addresses",
        "visible_addresses",
      ] as const
    ).every(
      (count) => view.masking?.left[count] === view.masking?.right[count],
    ));

/** Each normalized view must cite every recorded source selection, in either form. */
const validateNormalizedViewSources = (
  evidence: Evidence,
  result: FunctionComparisonResult,
): Result<void, EvidenceIntegrityError> => {
  const views = result.normalized_views?.views ?? [];
  if (views.length === 0) return ok(undefined);
  try {
    const { left, right } = comparisonSourceEvidenceSides(evidence);
    const sources = [...left, ...right];
    return views.every(({ evidence_links }) =>
      sources.every((source) => evidence_links.includes(source)),
    )
      ? ok(undefined)
      : err(
          new EvidenceIntegrityError(
            "Function comparison normalized views must cite every selected source Evidence record",
          ),
        );
  } catch (cause) {
    if (cause instanceof EvidenceIntegrityError) return err(cause);
    throw cause;
  }
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
