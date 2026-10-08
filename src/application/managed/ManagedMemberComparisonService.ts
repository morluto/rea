import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { z } from "zod";

import {
  compareManagedMembers,
  managedMemberComparisonResultSchema,
  parseManagedMemberEvidence,
  type CompareManagedMembersInput,
} from "../../domain/managed/managedMemberComparison.js";
import { AnalysisProtocolError } from "../../domain/analysisErrorCore.js";
import { EvidenceIntegrityError } from "../../domain/evidenceErrors.js";
import { type AnalysisError } from "../../domain/analysisErrorBase.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import { jsonValueSchema } from "../../domain/jsonValue.js";
import { parseBinaryTarget } from "../BinaryTargetResolver.js";
import { err, ok, type Result } from "../../domain/result.js";
import { inspectManagedMembersBytes } from "../../dotnet/ManagedMemberInspector.js";
import {
  MANAGED_STATIC_PROVIDER,
  MANAGED_WORKFLOW_PROVIDER,
} from "../InvestigationProviders.js";
import { managedInputError } from "./managedInputError.js";

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
    return workflowFailure(operation, cause, input);
  }
};

interface ManagedMemberComparisonPathDependencies {
  readonly resolveTarget: typeof parseBinaryTarget;
  readonly readBytes: (path: string) => Promise<Buffer>;
}

const DEFAULT_PATH_DEPENDENCIES: ManagedMemberComparisonPathDependencies = {
  resolveTarget: parseBinaryTarget,
  readBytes: readFile,
};

/** Inspect two local PE artifacts and return one derived comparison Evidence. */
export const compareManagedMemberPaths = async (
  input: {
    readonly leftPath: string;
    readonly rightPath: string;
  },
  dependencies: ManagedMemberComparisonPathDependencies = DEFAULT_PATH_DEPENDENCIES,
): Promise<Result<Evidence, AnalysisError>> => {
  const operation = "compare_managed_members";
  try {
    const [leftTarget, rightTarget] = await Promise.all([
      dependencies.resolveTarget(input.leftPath),
      dependencies.resolveTarget(input.rightPath),
    ]);
    // Report an unopenable path like every other path-based command does,
    // with the failed path and constraint, rather than a bare input error.
    if (!leftTarget.ok) return err(leftTarget.error);
    if (!rightTarget.ok) return err(rightTarget.error);
    const [leftBytes, rightBytes] = await Promise.all([
      dependencies.readBytes(leftTarget.value.path),
      dependencies.readBytes(rightTarget.value.path),
    ]);
    for (const [target, bytes] of [
      [leftTarget.value, leftBytes],
      [rightTarget.value, rightBytes],
    ] as const) {
      const observedSha256 = createHash("sha256").update(bytes).digest("hex");
      if (observedSha256 !== target.sha256)
        return err(
          new EvidenceIntegrityError(
            `Managed artifact digest changed after open: expected ${target.sha256}, observed ${observedSha256} at ${target.path}`,
          ),
        );
    }
    const leftInspection = inspectManagedMembersBytes(
      leftBytes,
      leftTarget.value,
    );
    const rightInspection = inspectManagedMembersBytes(
      rightBytes,
      rightTarget.value,
    );
    const leftEvidence = createEvidence(
      leftTarget.value,
      MANAGED_STATIC_PROVIDER,
      {
        operation: "inspect_managed_members",
        parameters: {},
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
        parameters: {},
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
    );
    return ok(
      createManagedMemberComparisonEvidence(
        {
          left: leftEvidence,
          right: rightEvidence,
        },
        result,
      ),
    );
  } catch (cause: unknown) {
    return workflowFailure(operation, cause, input);
  }
};

/** ECMA-335 representable limits for path-based member comparison. */

const createManagedMemberComparisonEvidence = (
  parameters: Pick<CompareManagedMembersInput, "left" | "right">,
  result: z.infer<typeof managedMemberComparisonResultSchema>,
): Evidence =>
  createEvidence(undefined, MANAGED_WORKFLOW_PROVIDER, {
    predicateType: "rea.managed-member-comparison",
    operation: "compare_managed_members",
    parameters: {
      left_evidence_id: parameters.left.evidence_id,
      right_evidence_id: parameters.right.evidence_id,
    },
    result: jsonValueSchema.parse(result),
    rawResult: null,
    confidence: "inferred",
    authority: "analyst-inference",
    environment: null,
    limitations: result.limitations,
    evidenceLinks: result.evidence_links,
  });

const workflowFailure = (
  operation: string,
  cause: unknown,
  input: unknown,
): Result<never, AnalysisError> =>
  err(
    cause instanceof z.ZodError || cause instanceof TypeError
      ? managedInputError(operation, cause, input)
      : new AnalysisProtocolError(
          "Managed member comparison produced an invalid result",
          { cause },
        ),
  );
