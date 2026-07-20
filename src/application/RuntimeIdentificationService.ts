import type { AnalysisError } from "../domain/errors.js";
import type { Evidence } from "../domain/evidence.js";
import {
  identifyRuntimes,
  runtimeIdentificationInputSchema,
} from "../domain/runtimeIdentification.js";
import type { Result } from "../domain/result.js";
import { RUNTIME_IDENTIFICATION_PROVIDER } from "./InvestigationProviders.js";
import { projectInventoryEvidence } from "./InventoryProjectionEvidence.js";

const OPERATION = "identify_runtime" as const;

/** Identify runtime families from authenticated artifact inventory Evidence. */
export const identifyRuntimeEvidence = (
  rawInput: unknown,
): Result<Evidence, AnalysisError> => {
  return projectInventoryEvidence({
    rawInput,
    schema: runtimeIdentificationInputSchema,
    project: identifyRuntimes,
    operation: OPERATION,
    predicateType: "rea.runtime-identification/v1",
    provider: RUNTIME_IDENTIFICATION_PROVIDER,
    subjectFormat: (first) => first.subject?.format ?? "unknown",
    protocolError: "Runtime identification produced an invalid result",
  });
};
