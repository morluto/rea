import { z } from "zod";

import { ANALYSIS_VIEW_PROVIDER } from "../InvestigationProviders.js";
import type { EvidenceLookup } from "../EvidenceInputResolver.js";
import { resolveEvidenceInput } from "../EvidenceInputResolver.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import { EvidenceIntegrityError } from "../../domain/evidenceErrors.js";
import {
  createEvidence,
  parseEvidence,
  type Evidence,
} from "../../domain/evidence.js";
import {
  INSPECT_ANALYSIS_VIEW_OPERATION,
  inspectAnalysisViewInputSchema,
  projectAnalysisView,
  type AnalysisViewResult,
  type InspectAnalysisViewInput,
} from "../../domain/analysisView/analysisView.js";
import { jsonValueSchema } from "../../domain/jsonValue.js";
import { err, ok, type Result } from "../../domain/result.js";

/** Authenticate a selected-view request and project already completed Evidence. */
export const inspectAnalysisView = (
  rawInput: unknown,
  lookup?: EvidenceLookup,
): Result<Evidence, AnalysisError> => {
  const parsed = inspectAnalysisViewInputSchema.safeParse(rawInput);
  if (!parsed.success)
    return err(
      analysisInputErrorFromIssues(
        INSPECT_ANALYSIS_VIEW_OPERATION,
        parsed.error.issues,
        rawInput,
        { cause: parsed.error },
      ),
    );
  return inspectAnalysisViewValidated(parsed.data, lookup);
};

/** Project a view from input already parsed by a trusted adapter. */
export const inspectAnalysisViewValidated = (
  input: InspectAnalysisViewInput,
  lookup?: EvidenceLookup,
): Result<Evidence, AnalysisError> => {
  const resolved = resolveAnalysisViewSource(input.source, lookup);
  if (!resolved.ok) return resolved;
  const parent = resolved.value;
  const projected = projectAnalysisView(
    {
      evidenceId: parent.evidence_id,
      operation: parent.operation,
      normalizedResult: parent.normalized_result,
      limitations: parent.limitations,
      artifact:
        parent.subject === null
          ? null
          : {
              path: parent.subject.local_path,
              sha256: parent.subject.digest.sha256,
            },
    },
    input.view,
  );
  if (!projected.ok) return projected;
  if (
    parent.subject !== null &&
    parent.subject.digest.sha256 !== projected.value.artifact.sha256
  )
    return err(
      new EvidenceIntegrityError(
        `Parent subject SHA-256 ${parent.subject.digest.sha256} differs from analysis artifact SHA-256 ${projected.value.artifact.sha256}.`,
      ),
    );
  return ok(createAnalysisViewEvidence(input, parent, projected.value));
};

const resolveAnalysisViewSource = (
  source: InspectAnalysisViewInput["source"],
  lookup: EvidenceLookup | undefined,
): Result<Evidence, AnalysisError> => {
  if (source.kind === "retained-evidence")
    return resolveEvidenceInput(source, lookup);
  try {
    return ok(parseEvidence(source.evidence));
  } catch (cause: unknown) {
    if (cause instanceof z.ZodError)
      return err(
        analysisInputErrorFromIssues(
          INSPECT_ANALYSIS_VIEW_OPERATION,
          cause.issues,
          source.evidence,
          { cause },
        ),
      );
    if (cause instanceof TypeError)
      return err(
        new EvidenceIntegrityError(
          cause.message,
          cause.message.length > 0 ? { userMessage: cause.message } : undefined,
        ),
      );
    throw cause;
  }
};

const createAnalysisViewEvidence = (
  input: InspectAnalysisViewInput,
  parent: Evidence,
  result: AnalysisViewResult,
): Evidence => {
  const target =
    parent.subject === null
      ? undefined
      : {
          path: parent.subject.local_path,
          sha256: parent.subject.digest.sha256,
          format: parent.subject.format,
          ...(parent.subject.architecture === null
            ? {}
            : { architecture: parent.subject.architecture }),
        };
  return createEvidence(target, ANALYSIS_VIEW_PROVIDER, {
    predicateType: "rea.analysis-view",
    operation: INSPECT_ANALYSIS_VIEW_OPERATION,
    parameters: {
      parent_evidence_id: parent.evidence_id,
      view: jsonValueSchema.parse(input.view),
    },
    result: jsonValueSchema.parse(result),
    rawResult: null,
    confidence: "derived",
    authority: parent.authority,
    limitations: result.limitations,
    locations: [
      ...(result.artifact.path.length > 0
        ? [{ kind: "artifact-path" as const, path: result.artifact.path }]
        : []),
      ...(result.kind === "native" &&
      result.procedure_address !== null &&
      result.procedure_address.length > 0
        ? [{ kind: "address" as const, address: result.procedure_address }]
        : []),
    ],
    evidenceLinks: [parent.evidence_id],
  });
};
