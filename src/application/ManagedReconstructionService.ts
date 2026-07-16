import { z } from "zod";

import {
  AnalysisInputError,
  AnalysisProtocolError,
  type AnalysisError,
} from "../domain/errors.js";
import { createEvidence, type Evidence } from "../domain/evidence.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import {
  importManagedReconstruction,
  managedReconstructionImportInputSchema,
  type ManagedReconstructionImportInput,
  type ManagedReconstructionImportResult,
} from "../domain/managedReconstruction.js";
import { err, ok, type Result } from "../domain/result.js";
import { MANAGED_WORKFLOW_PROVIDER } from "./InvestigationProviders.js";

const OPERATION = "import_managed_reconstruction" as const;

/** Authenticate and import managed decompiler reconstruction as Evidence. */
export const importManagedReconstructionEvidence = (
  rawInput: unknown,
): Result<Evidence, AnalysisError> => {
  const parsed = managedReconstructionImportInputSchema.safeParse(rawInput);
  if (!parsed.success)
    return err(new AnalysisInputError(OPERATION, { cause: parsed.error }));
  try {
    const result = importManagedReconstruction(parsed.data);
    return ok(createManagedReconstructionEvidence(parsed.data, result));
  } catch (cause: unknown) {
    return err(
      cause instanceof TypeError || cause instanceof z.ZodError
        ? new AnalysisInputError(OPERATION, { cause })
        : new AnalysisProtocolError(
            "Managed reconstruction import produced an invalid result",
            { cause },
          ),
    );
  }
};

const createManagedReconstructionEvidence = (
  input: ManagedReconstructionImportInput,
  result: ManagedReconstructionImportResult,
): Evidence =>
  createEvidence(
    {
      path: result.static_observation.artifact_path,
      sha256: result.static_observation.artifact_sha256,
      format: "pe",
    },
    MANAGED_WORKFLOW_PROVIDER,
    {
      predicateType: "rea.managed-reconstruction-import/v1",
      operation: OPERATION,
      parameters: {
        static_members_evidence_id: input.static_members.evidence_id,
        decompiler: jsonValueSchema.parse(result.decompiler),
        method_locks: jsonValueSchema.parse(
          input.methods.map(
            ({ token, signature_sha256, normalized_il_sha256 }) => ({
              token,
              signature_sha256,
              normalized_il_sha256,
            }),
          ),
        ),
        notes: jsonValueSchema.parse(input.notes),
      },
      result: jsonValueSchema.parse(result),
      rawResult: null,
      confidence: "inferred",
      authority: "analyst-inference",
      environment: null,
      limitations: result.limitations,
      locations: [
        {
          kind: "artifact-path",
          path: result.static_observation.artifact_path,
        },
      ],
      evidenceLinks: result.evidence_links,
    },
  );
