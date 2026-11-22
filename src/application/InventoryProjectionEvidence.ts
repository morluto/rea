import type { z } from "zod";
import type { EvidenceRequestFrameInput } from "../domain/evidenceInputContract.js";
import { unknownTarget } from "../domain/targetIdentity.js";
import {
  resolveEvidenceRequest,
  type EvidenceLookup,
} from "./EvidenceInputResolver.js";
import type { ExecutionOptions } from "../ports/AnalysisProvider.js";
import type { AnalysisInputError } from "../domain/analysisErrorCore.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  createEvidence,
  type Evidence,
  type EvidenceProvider,
  evidenceSubjectInput,
} from "../domain/evidence.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { ParsedInventorySet } from "../domain/artifactInventoryEvidence.js";
import { readApplicationInventoryProjection } from "../domain/mobileApplicationGraphProjection.js";
import { ok, type Result } from "../domain/result.js";

interface InventoryProjectionResult {
  readonly root_sha256: string;
  readonly source_evidence_ids: readonly string[];
  readonly limitations: readonly string[];
}

export interface InventoryProjectionEvidenceResult {
  readonly evidence: Evidence;
  readonly sources: readonly Evidence[];
}

interface InventoryProjectionOptions<
  Schema extends z.ZodType<{ inventory_evidence: unknown[] }>,
  Output extends InventoryProjectionResult & JsonValue,
> {
  readonly rawInput: unknown;
  readonly inputSchema: Schema;
  readonly lookup?: EvidenceLookup;
  readonly execution?: Pick<ExecutionOptions, "signal">;
  readonly project: (
    inventory: ParsedInventorySet,
    input: EvidenceRequestFrameInput<z.output<Schema>>,
  ) => Result<Output, AnalysisInputError>;
  readonly inputParameters?: (
    input: EvidenceRequestFrameInput<z.output<Schema>>,
  ) => Readonly<Record<string, JsonValue>>;
  readonly operation: string;
  readonly predicateType: string;
  readonly provider: EvidenceProvider;
}

/** Resolve source inventory once, then wrap its family projection in Evidence. */
export const projectInventoryEvidence = <
  Schema extends z.ZodType<{ inventory_evidence: unknown[] }>,
  Output extends InventoryProjectionResult & JsonValue,
>(
  options: InventoryProjectionOptions<Schema, Output>,
): Result<InventoryProjectionEvidenceResult, AnalysisError> => {
  const request = resolveEvidenceRequest(
    options.operation,
    options.rawInput,
    options.inputSchema,
    options.lookup,
    options.execution,
  );
  if (!request.ok) return request;
  const source = readApplicationInventoryProjection(
    request.value.input.inventory_evidence,
    options.operation,
  );
  if (!source.ok) return source;
  const projected = options.project(source.value, request.value.input);
  if (!projected.ok) return projected;
  const result = projected.value;
  const first = source.value.evidence[0];
  return ok({
    evidence: createEvidence(
      first === undefined
        ? unknownTarget("derived-from-linked-evidence")
        : evidenceSubjectInput(first.subject),
      options.provider,
      {
        predicateType: options.predicateType,
        operation: options.operation,
        parameters: {
          inventory_evidence_ids: [...result.source_evidence_ids],
          ...options.inputParameters?.(request.value.input),
        },
        result,
        rawResult: null,
        confidence: "inferred",
        authority: "analyst-inference",
        environment: null,
        limitations: result.limitations,
        evidenceLinks: result.source_evidence_ids,
      },
    ),
    sources: source.value.evidence,
  });
};
