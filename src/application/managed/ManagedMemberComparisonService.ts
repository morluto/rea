import { z } from "zod";

import {
  compareManagedMembers,
  managedMemberComparisonResultSchema,
  type CompareManagedMembersInput,
} from "../../domain/managed/managedMemberComparison.js";
import { parseManagedMemberEvidence } from "../../domain/managed/managedMemberComparisonMatch.js";
import type { BinaryTarget } from "../../domain/binaryTargetTypes.js";
import type { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import { AnalysisProtocolError } from "../../domain/analysisErrorCore.js";
import { EvidenceIntegrityError } from "../../domain/evidenceErrors.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import { jsonValueSchema } from "../../domain/jsonValue.js";
import {
  classifyBinaryTargetFilesystemFailure,
  parseBinaryTarget,
} from "../BinaryTargetResolver.js";
import { err, ok, type Result } from "../../domain/result.js";
import { inspectManagedMembersBytes } from "../../dotnet/ManagedMemberInspector.js";
import { readManagedSnapshot } from "../../dotnet/ManagedSnapshot.js";
import {
  MANAGED_STATIC_PROVIDER,
  MANAGED_WORKFLOW_PROVIDER,
} from "../InvestigationProviders.js";
import { workflowInputError } from "../workflowInputError.js";

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
    );
    return ok(createManagedMemberComparisonEvidence(input, result));
  } catch (cause: unknown) {
    return workflowFailure(operation, cause);
  }
};

interface ManagedMemberComparisonPathDependencies {
  readonly resolveTarget: typeof parseBinaryTarget;
  readonly readSnapshot: typeof readManagedSnapshot;
}

/** Inspect two local PE artifacts and return one derived comparison Evidence. */
export const compareManagedMemberPaths = async (
  input: {
    readonly leftPath: string;
    readonly rightPath: string;
  },
  dependencies: Partial<ManagedMemberComparisonPathDependencies> = {},
  resources?: ArtifactResourceScope,
): Promise<Result<Evidence, AnalysisError>> => {
  const operation = "compare_managed_members";
  const resolveTarget = dependencies.resolveTarget ?? parseBinaryTarget;
  const readSnapshot = dependencies.readSnapshot ?? readManagedSnapshot;
  let partialEvidence: Evidence | undefined;
  try {
    const [leftTarget, rightTarget] = await Promise.all([
      resolveTarget(input.leftPath),
      resolveTarget(input.rightPath),
    ]);
    // Report an unopenable path like every other path-based command does,
    // with the failed path and constraint, rather than a bare input error.
    if (!leftTarget.ok) return err(leftTarget.error);
    if (!rightTarget.ok) return err(rightTarget.error);
    const inspectTarget = async (
      target: BinaryTarget,
      selectedPath: string,
    ) => {
      const { path } = target;
      let snapshot: Awaited<ReturnType<typeof readManagedSnapshot>>;
      try {
        snapshot = await readSnapshot(
          path,
          operation,
          resources === undefined ? {} : { resources },
        );
      } catch (cause: unknown) {
        const failure = classifyBinaryTargetFilesystemFailure(path, cause);
        if (failure !== undefined) throw failure;
        throw cause;
      }
      if (snapshot.sha256 !== target.sha256)
        throw new EvidenceIntegrityError(
          `Managed artifact digest changed after open: expected ${target.sha256}, observed ${snapshot.sha256} at ${target.path}`,
        );
      const inspection = inspectManagedMembersBytes(snapshot.bytes, target);
      const evidence = createEvidence(target, MANAGED_STATIC_PROVIDER, {
        operation: "inspect_managed_members",
        parameters: {},
        result: jsonValueSchema.parse(inspection),
        rawResult: null,
        limitations: inspection.limitations,
        locations: [{ kind: "artifact-path", path: selectedPath }],
      });
      return { inspection, evidence };
    };
    const left = await inspectTarget(leftTarget.value, input.leftPath);
    partialEvidence = left.evidence;
    const right = await inspectTarget(rightTarget.value, input.rightPath);
    const result = compareManagedMembers(
      {
        evidenceId: left.evidence.evidence_id,
        result: left.inspection,
      },
      {
        evidenceId: right.evidence.evidence_id,
        result: right.inspection,
      },
    );
    return ok(
      createManagedMemberComparisonEvidence(
        {
          left: left.evidence,
          right: right.evidence,
        },
        result,
        { leftPath: input.leftPath, rightPath: input.rightPath },
      ),
    );
  } catch (cause: unknown) {
    return workflowFailure(operation, cause, partialEvidence);
  }
};

const createManagedMemberComparisonEvidence = (
  parameters: Pick<CompareManagedMembersInput, "left" | "right">,
  result: z.infer<typeof managedMemberComparisonResultSchema>,
  sourcePaths?: { readonly leftPath: string; readonly rightPath: string },
): Evidence =>
  createEvidence(undefined, MANAGED_WORKFLOW_PROVIDER, {
    predicateType: "rea.managed-member-comparison",
    operation: "compare_managed_members",
    parameters: {
      left_evidence_id: parameters.left.evidence_id,
      right_evidence_id: parameters.right.evidence_id,
      ...(sourcePaths === undefined
        ? {}
        : {
            left_path: sourcePaths.leftPath,
            right_path: sourcePaths.rightPath,
          }),
    },
    result: jsonValueSchema.parse(result),
    rawResult: null,
    confidence: "inferred",
    authority: "analyst-inference",
    environment: null,
    limitations: result.limitations,
    locations:
      sourcePaths === undefined
        ? []
        : [
            { kind: "artifact-path", path: sourcePaths.leftPath },
            { kind: "artifact-path", path: sourcePaths.rightPath },
          ],
    evidenceLinks: result.evidence_links,
  });

const workflowFailure = (
  operation: string,
  cause: unknown,
  partialEvidence?: Evidence,
): Result<never, AnalysisError> => {
  const failure =
    cause instanceof AnalysisError
      ? cause
      : cause instanceof z.ZodError || cause instanceof TypeError
        ? workflowInputError(operation, cause)
        : new AnalysisProtocolError(
            "Managed member comparison produced an invalid result",
            { cause },
          );
  return err(
    partialEvidence === undefined
      ? failure
      : failure.retainPartialObservation(partialEvidence),
  );
};
