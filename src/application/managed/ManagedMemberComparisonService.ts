import { unknownTarget } from "../../domain/targetIdentity.js";
import {
  resolveEvidenceRequest,
  type EvidenceLookup,
} from "../EvidenceInputResolver.js";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";

import {
  compareManagedMembers,
  compareManagedMembersRequestSchema,
  type ManagedMemberComparisonResult,
} from "../../domain/managed/managedMemberComparison.js";
import { readManagedMemberEvidence } from "../../domain/managed/managedMemberComparisonMatch.js";
import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import { err, ok, type Result } from "../../domain/result.js";
import { MANAGED_WORKFLOW_PROVIDER } from "../../domain/investigationProviders.js";
import type { InvestigationWorkflowExecution } from "../investigation/InvestigationWorkflows.js";
import { workflowUnknownInput } from "../investigation/WorkflowUnknown.js";

export interface ManagedMemberComparisonExecution {
  readonly evidence: Evidence;
  readonly summary: ManagedMemberComparisonResult["summary"];
  readonly sources: readonly [Evidence, Evidence];
}

/**
 * The local paths a caller selected for each side and the inspection fields
 * both sides were inspected with, recorded as comparison request facts.
 */
export interface ManagedMemberComparisonSelection {
  readonly leftPath: string;
  readonly rightPath: string;
  readonly inspection: Readonly<Record<string, JsonValue>>;
}

/** Authenticate both source records, then compare their parsed observations. */
export const executeManagedMemberComparison = (
  input: unknown,
  lookup?: EvidenceLookup,
  options: Pick<ExecutionOptions, "signal"> & {
    readonly selection?: ManagedMemberComparisonSelection;
  } = {},
): Result<ManagedMemberComparisonExecution, AnalysisError> => {
  const operation = "compare_managed_members";
  const request = resolveEvidenceRequest(
    operation,
    input,
    compareManagedMembersRequestSchema,
    lookup,
    options,
  );
  if (!request.ok) return request;
  const left = readManagedMemberEvidence(request.value.input.left, "left");
  if (!left.ok) return left;
  const right = readManagedMemberEvidence(request.value.input.right, "right");
  if (!right.ok) return right;
  if (left.value.evidence.evidence_id === right.value.evidence.evidence_id)
    return err(
      new AnalysisInputError(operation, undefined, [
        {
          path: ["right"],
          reason: "invalid_value",
          message: "Managed member Evidence must be distinct",
        },
      ]),
    );
  const result = compareManagedMembers(
    {
      evidenceId: left.value.evidence.evidence_id,
      result: left.value.result,
    },
    {
      evidenceId: right.value.evidence.evidence_id,
      result: right.value.result,
    },
  );
  const evidence = createManagedMemberComparisonEvidence(
    left.value.evidence,
    right.value.evidence,
    result,
    options.selection,
  );
  return ok({
    evidence,
    summary: result.summary,
    sources: [left.value.evidence, right.value.evidence],
  });
};

/**
 * Compare session-held inspections and keep members that remain unmatched or
 * ambiguous as the comparison's residual unknown.
 */
export const compareManagedMembersExecution = (
  input: unknown,
  lookup: EvidenceLookup,
  options: Pick<ExecutionOptions, "signal">,
): Result<InvestigationWorkflowExecution, AnalysisError> => {
  const compared = executeManagedMemberComparison(input, lookup, options);
  if (!compared.ok) return compared;
  const { evidence, sources, summary } = compared.value;
  if (summary.unknown === 0)
    return ok({ evidence, sources, unknown: undefined });
  const unknown = workflowUnknownInput(evidence.evidence_id, {
    question:
      "Which managed members remain unmatched or ambiguous across these versions?",
    severity: "medium",
    domain: "managed-member-comparison",
    required_authority: "shipped-artifact",
    required_confidence: "observed",
    required_environment: null,
    recommended_probes: [
      {
        operation: "inspect_managed_members",
        rationale:
          "Review the inspection Evidence coverage and limit diagnostics; this operation has no page override, so unresolved members must remain unknown.",
      },
    ],
    relationships: [],
  });
  return unknown.ok
    ? ok({ evidence, sources, unknown: unknown.value })
    : unknown;
};

const createManagedMemberComparisonEvidence = (
  left: Evidence,
  right: Evidence,
  result: ManagedMemberComparisonResult,
  selection?: ManagedMemberComparisonSelection,
): Evidence =>
  createEvidence(
    unknownTarget("derived-from-linked-evidence"),
    MANAGED_WORKFLOW_PROVIDER,
    {
      predicateType: "rea.managed-member-comparison",
      operation: "compare_managed_members",
      parameters: {
        left_evidence_id: left.evidence_id,
        right_evidence_id: right.evidence_id,
        ...(selection === undefined
          ? {}
          : {
              left_path: selection.leftPath,
              right_path: selection.rightPath,
              ...selection.inspection,
            }),
      },
      result,
      rawResult: null,
      confidence: "inferred",
      authority: "analyst-inference",
      environment: null,
      limitations: result.limitations,
      locations:
        selection === undefined
          ? []
          : [
              { kind: "artifact-path", path: selection.leftPath },
              { kind: "artifact-path", path: selection.rightPath },
            ],
      evidenceLinks: result.evidence_links,
    },
  );
