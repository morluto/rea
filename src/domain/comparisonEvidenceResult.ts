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
  sameMaskingCounts,
  type FunctionComparisonResult,
} from "./functionComparisonSchemas.js";
import {
  processCaptureComparisonSchema,
  type ProcessCaptureComparison,
} from "./process/processComparison.js";
import {
  webScreenshotDiffSchema,
  type WebScreenshotDiff,
} from "./webScreenshot.js";
import { err, ok, type Result } from "./result.js";
import { comparisonSourceEvidenceSides } from "./comparisonSourceEvidence.js";

type ComparisonResults = {
  readonly compare_artifacts: ArtifactComparisonResult;
  readonly compare_functions: FunctionComparisonResult;
  readonly compare_process_captures: ProcessCaptureComparison;
  readonly compare_web_screenshots: WebScreenshotDiff;
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
      { within: ["normalized_result"] },
    );
    if (!parsed.ok) return parsed;
    return ok({ operation, evidence, result: parsed.value });
  }
  if (operation === "compare_functions") {
    const parsed = readEvidencePayload(
      functionComparisonResultSchema,
      evidence.normalized_result,
      { within: ["normalized_result"] },
    );
    if (!parsed.ok) return parsed;
    const optIn = validateNormalizedViewOptIn(evidence, parsed.value);
    if (!optIn.ok) return optIn;
    const self = validateSelfComparison(evidence, parsed.value);
    if (!self.ok) return self;
    const links = validateFindingLinks(
      evidence,
      functionComparisonFindingLinks(parsed.value),
    );
    if (!links.ok) return links;
    const sources = validateNormalizedViewSources(evidence, parsed.value);
    if (!sources.ok) return sources;
    return ok({ operation, evidence, result: parsed.value });
  }
  if (operation === "compare_web_screenshots") {
    const parsed = readEvidencePayload(
      webScreenshotDiffSchema,
      evidence.normalized_result,
      { within: ["normalized_result"] },
    );
    if (!parsed.ok) return parsed;
    return ok({ operation, evidence, result: parsed.value });
  }
  const parsed = readEvidencePayload(
    artifactComparisonResultSchema,
    evidence.normalized_result,
    { within: ["normalized_result"] },
  );
  if (!parsed.ok) return parsed;
  const links = validateFindingLinks(evidence, [
    ...parsed.value.changes.flatMap(({ evidence_links }) => evidence_links),
    // optional-fact-default: only retained IDs are links to validate.
    ...(parsed.value.integrity_mismatch_evidence_ids ?? []),
  ]);
  if (!links.ok) return links;
  return ok({ operation, evidence, result: parsed.value });
}

/** The recorded caller opt-in, not the payload, decides whether views exist. */
const validateNormalizedViewOptIn = (
  evidence: Evidence,
  result: FunctionComparisonResult,
): Result<void, EvidenceIntegrityError> => {
  const selection = evidence.parameters["include_normalized_views"];
  if (selection !== undefined && typeof selection !== "boolean")
    return err(
      new EvidenceIntegrityError(
        "Function comparison include_normalized_views selection is not a boolean",
      ),
    );
  const allowance = evidence.parameters["max_named_symbol_code_units"];
  if (
    allowance !== undefined &&
    (selection !== true ||
      typeof allowance !== "number" ||
      !Number.isSafeInteger(allowance) ||
      allowance < 1)
  )
    return err(
      new EvidenceIntegrityError(
        "Function comparison max_named_symbol_code_units is not a positive safe integer recorded with include_normalized_views",
      ),
    );
  return (selection === true) === (result.normalized_views !== undefined)
    ? ok(undefined)
    : err(
        new EvidenceIntegrityError(
          "Function comparison normalized views disagree with the recorded include_normalized_views selection",
        ),
      );
};

type NormalizedView = NonNullable<
  FunctionComparisonResult["normalized_views"]
>["views"][number];

/** One source projects the same facts on both sides, whatever a view concludes. */
const sameProjectedFacts = (view: NormalizedView): boolean =>
  view.left_digest === view.right_digest &&
  view.left_count === view.right_count &&
  (view.masking === null ||
    sameMaskingCounts(view.masking.left, view.masking.right));

/**
 * A comparison whose sides select one Evidence record has nothing to report as
 * changed, whatever match method it records: with known coordinates the shared
 * entry matches (`same-entry`) before the record identity (`same-evidence`).
 * The selected sources decide, as they decide the producer's endpoint handling.
 */
const validateSelfComparison = (
  evidence: Evidence,
  result: FunctionComparisonResult,
): Result<void, EvidenceIntegrityError> => {
  const recordedSame = result.function_match.method === "same-evidence";
  let sides: ReturnType<typeof comparisonSourceEvidenceSides>;
  try {
    sides = comparisonSourceEvidenceSides(evidence);
  } catch (cause) {
    if (!(cause instanceof EvidenceIntegrityError)) throw cause;
    // Without readable sides only a recorded same-Evidence match makes the claim;
    // the views' own source check still reports an unreadable selection.
    return recordedSame ? err(cause) : ok(undefined);
  }
  const { left, right } = sides;
  const sourceId =
    left.length === 1 && right.length === 1 && left[0] === right[0]
      ? left[0]
      : undefined;
  if (!recordedSame && sourceId === undefined) return ok(undefined);
  // optional-fact-default: the opt-in check admits absent views only when none were requested.
  const views = result.normalized_views?.views ?? [];
  // Normalized views project the same source, so they share its invariants.
  const conclusions = [...result.dimensions, ...views];
  const sameSource =
    sourceId !== undefined &&
    evidence.evidence_links.includes(sourceId) &&
    conclusions.every(({ evidence_links }) =>
      evidence_links.every((id) => id === sourceId),
    );
  const impossibleChange =
    result.left_subject_sha256 !== result.right_subject_sha256 ||
    conclusions.some(
      (dimension) =>
        dimension.status === "changed" ||
        (dimension.status === "unchanged" &&
          dimension.left_digest !== dimension.right_digest),
    ) ||
    views.some((view) => !sameProjectedFacts(view));
  return !sameSource || impossibleChange
    ? err(
        new EvidenceIntegrityError(
          "Same-Evidence function comparison must cite the same source on both sides",
        ),
      )
    : ok(undefined);
};

/** Each normalized view must cite every recorded source selection, in either form. */
const validateNormalizedViewSources = (
  evidence: Evidence,
  result: FunctionComparisonResult,
): Result<void, EvidenceIntegrityError> => {
  // optional-fact-default: the opt-in check admits absent views only when none were requested.
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
