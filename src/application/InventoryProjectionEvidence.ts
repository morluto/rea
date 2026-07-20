import { z } from "zod";

import {
  AnalysisInputError,
  AnalysisProtocolError,
  type AnalysisError,
} from "../domain/errors.js";
import {
  createEvidence,
  type Evidence,
  type EvidenceProvider,
  type EvidenceSubjectTarget,
} from "../domain/evidence.js";
import { jsonValueSchema, type JsonValue } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";

interface InventoryProjectionInput {
  readonly inventory_evidence: readonly Evidence[];
  readonly limits: unknown;
}

interface InventoryProjectionResult {
  readonly root_sha256: string;
  readonly source_evidence_ids: readonly string[];
  readonly limitations: readonly string[];
}

interface InventoryProjectionOptions<
  Input extends InventoryProjectionInput,
  Output extends InventoryProjectionResult,
> {
  readonly rawInput: unknown;
  readonly schema: z.ZodType<Input>;
  readonly project: (input: Input) => Output;
  readonly operation: string;
  readonly predicateType: string;
  readonly provider: EvidenceProvider;
  readonly subjectFormat: (first: Evidence) => EvidenceSubjectTarget["format"];
  readonly protocolError: string;
}

/** Parse one inventory projection and wrap its deterministic result in Evidence v2. */
export const projectInventoryEvidence = <
  Input extends InventoryProjectionInput,
  Output extends InventoryProjectionResult,
>(
  options: InventoryProjectionOptions<Input, Output>,
): Result<Evidence, AnalysisError> => {
  const parsed = options.schema.safeParse(options.rawInput);
  if (!parsed.success)
    return err(
      new AnalysisInputError(options.operation, { cause: parsed.error }),
    );
  try {
    const result = options.project(parsed.data);
    const first = parsed.data.inventory_evidence[0];
    return ok(
      createEvidence(
        first?.subject === null || first?.subject === undefined
          ? undefined
          : {
              path: first.subject.local_path,
              sha256: result.root_sha256,
              format: options.subjectFormat(first),
            },
        options.provider,
        {
          predicateType: options.predicateType,
          operation: options.operation,
          parameters: {
            inventory_evidence_ids: [...result.source_evidence_ids],
            limits: jsonValueSchema.parse(parsed.data.limits),
          },
          result: jsonValueSchema.parse(result) as JsonValue,
          rawResult: null,
          confidence: "inferred",
          authority: "analyst-inference",
          environment: null,
          limitations: result.limitations,
          evidenceLinks: result.source_evidence_ids,
        },
      ),
    );
  } catch (cause: unknown) {
    return err(
      cause instanceof TypeError || cause instanceof z.ZodError
        ? new AnalysisInputError(options.operation, { cause })
        : new AnalysisProtocolError(options.protocolError, { cause }),
    );
  }
};
