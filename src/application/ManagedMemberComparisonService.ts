import { readFile, stat } from "node:fs/promises";

import { z } from "zod";

import {
  compareManagedMembers,
  managedMemberComparisonResultSchema,
  parseManagedMemberEvidence,
  type CompareManagedMembersInput,
} from "../domain/managedMemberComparison.js";
import {
  AnalysisInputError,
  AnalysisProtocolError,
  type AnalysisError,
} from "../domain/errors.js";
import { createEvidence, type Evidence } from "../domain/evidence.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import { parseBinaryTarget } from "../domain/binaryTarget.js";
import { err, ok, type Result } from "../domain/result.js";
import { inspectManagedMembersBytes } from "../dotnet/ManagedMemberInspector.js";
import { MANAGED_STATIC_PROVIDER } from "./InvestigationProviders.js";
import { MANAGED_WORKFLOW_PROVIDER } from "./InvestigationProviders.js";

/** Compare managed members from input parsed by a trusted adapter. */
export const compareManagedMembersEvidenceValidated = (
  input: CompareManagedMembersInput,
): Result<Evidence, AnalysisError> => {
  const operation = "compare_managed_members";
  try {
    const left = parseManagedMemberEvidence(input.left);
    const right = parseManagedMemberEvidence(input.right);
    const result = compareManagedMembers(
      { evidenceId: left.evidenceId, result: left.result },
      { evidenceId: right.evidenceId, result: right.result },
      input.limits,
    );
    return ok(createManagedMemberComparisonEvidence(input, result));
  } catch (cause: unknown) {
    return workflowFailure(operation, cause);
  }
};

/** Inspect two local PE artifacts and return one derived comparison Evidence. */
export const compareManagedMemberPaths = async (input: {
  readonly leftPath: string;
  readonly rightPath: string;
  readonly memberLimits: ManagedMemberPathInspectionLimits;
  readonly comparisonLimits: CompareManagedMembersInput["limits"];
}): Promise<Result<Evidence, AnalysisError>> => {
  const operation = "compare_managed_members";
  try {
    const [leftTarget, rightTarget] = await Promise.all([
      parseBinaryTarget(input.leftPath),
      parseBinaryTarget(input.rightPath),
    ]);
    if (!leftTarget.ok)
      return err(
        new AnalysisInputError(operation, { cause: leftTarget.error }),
      );
    if (!rightTarget.ok)
      return err(
        new AnalysisInputError(operation, { cause: rightTarget.error }),
      );
    const [leftStat, rightStat] = await Promise.all([
      stat(leftTarget.value.path),
      stat(rightTarget.value.path),
    ]);
    if (
      leftStat.size > input.memberLimits.maxFileBytes ||
      rightStat.size > input.memberLimits.maxFileBytes
    )
      return err(
        new AnalysisInputError(operation, {
          cause: new RangeError(
            `Managed comparison input exceeds max_file_bytes ${String(input.memberLimits.maxFileBytes)}`,
          ),
        }),
      );
    const [leftBytes, rightBytes] = await Promise.all([
      readFile(leftTarget.value.path),
      readFile(rightTarget.value.path),
    ]);
    const leftInspection = inspectManagedMembersBytes(
      leftBytes,
      leftTarget.value,
      input.memberLimits,
    );
    const rightInspection = inspectManagedMembersBytes(
      rightBytes,
      rightTarget.value,
      input.memberLimits,
    );
    const leftEvidence = createEvidence(
      leftTarget.value,
      MANAGED_STATIC_PROVIDER,
      {
        operation: "inspect_managed_members",
        parameters: memberLimitParameters(input.memberLimits),
        result: jsonValueSchema.parse(leftInspection),
        rawResult: null,
        limitations: leftInspection.limitations,
        locations: [{ kind: "artifact-path", path: leftTarget.value.path }],
      },
    );
    const rightEvidence = createEvidence(
      rightTarget.value,
      MANAGED_STATIC_PROVIDER,
      {
        operation: "inspect_managed_members",
        parameters: memberLimitParameters(input.memberLimits),
        result: jsonValueSchema.parse(rightInspection),
        rawResult: null,
        limitations: rightInspection.limitations,
        locations: [{ kind: "artifact-path", path: rightTarget.value.path }],
      },
    );
    const result = compareManagedMembers(
      {
        evidenceId: leftEvidence.evidence_id,
        result: leftInspection,
      },
      {
        evidenceId: rightEvidence.evidence_id,
        result: rightInspection,
      },
      input.comparisonLimits,
    );
    return ok(
      createManagedMemberComparisonEvidence(
        {
          left: leftEvidence,
          right: rightEvidence,
          limits: input.comparisonLimits,
        },
        result,
      ),
    );
  } catch (cause: unknown) {
    return workflowFailure(operation, cause);
  }
};

export interface ManagedMemberPathInspectionLimits {
  readonly maxFileBytes: number;
  readonly typeOffset: number;
  readonly typeLimit: number;
  readonly methodOffset: number;
  readonly methodLimit: number;
  readonly fieldOffset: number;
  readonly fieldLimit: number;
  readonly memberRefOffset: number;
  readonly memberRefLimit: number;
  readonly edgeOffset: number;
  readonly edgeLimit: number;
  readonly instructionAnchorLimit: number;
  readonly maxMetadataBytes: number;
  readonly maxTableRows: number;
  readonly maxHeapItemBytes: number;
  readonly maxMethodBodyBytes: number;
  readonly maxMethodInstructions: number;
}

const createManagedMemberComparisonEvidence = (
  parameters: Pick<CompareManagedMembersInput, "left" | "right" | "limits">,
  result: z.infer<typeof managedMemberComparisonResultSchema>,
): Evidence =>
  createEvidence(undefined, MANAGED_WORKFLOW_PROVIDER, {
    predicateType: "rea.managed-member-comparison/v1",
    operation: "compare_managed_members",
    parameters: {
      left_evidence_id: parameters.left.evidence_id,
      right_evidence_id: parameters.right.evidence_id,
      limits: jsonValueSchema.parse(parameters.limits),
    },
    result: jsonValueSchema.parse(result),
    rawResult: null,
    confidence: "inferred",
    authority: "analyst-inference",
    environment: null,
    limitations: result.limitations,
    evidenceLinks: result.evidence_links,
  });

const memberLimitParameters = (
  limits: ManagedMemberPathInspectionLimits,
): Record<string, ReturnType<typeof jsonValueSchema.parse>> => ({
  type_offset: limits.typeOffset,
  type_limit: limits.typeLimit,
  method_offset: limits.methodOffset,
  method_limit: limits.methodLimit,
  field_offset: limits.fieldOffset,
  field_limit: limits.fieldLimit,
  member_ref_offset: limits.memberRefOffset,
  member_ref_limit: limits.memberRefLimit,
  edge_offset: limits.edgeOffset,
  edge_limit: limits.edgeLimit,
  instruction_anchor_limit: limits.instructionAnchorLimit,
  max_file_bytes: limits.maxFileBytes,
  max_metadata_bytes: limits.maxMetadataBytes,
  max_table_rows: limits.maxTableRows,
  max_heap_item_bytes: limits.maxHeapItemBytes,
  max_method_body_bytes: limits.maxMethodBodyBytes,
  max_method_instructions: limits.maxMethodInstructions,
});

const workflowFailure = (
  operation: string,
  cause: unknown,
): Result<never, AnalysisError> =>
  err(
    cause instanceof z.ZodError || cause instanceof TypeError
      ? new AnalysisInputError(operation, { cause })
      : new AnalysisProtocolError(
          "Managed member comparison produced an invalid result",
          { cause },
        ),
  );
