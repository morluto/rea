import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { Evidence } from "../domain/evidence.js";
import {
  appleApplicationProjectionInputSchema,
  projectAppleApplication,
} from "../domain/appleApplication.js";
import type { Result } from "../domain/result.js";
import { APPLE_APPLICATION_PROVIDER } from "./InvestigationProviders.js";
import { projectInventoryEvidence } from "./InventoryProjectionEvidence.js";

const OPERATION = "project_apple_application_graph" as const;

/** Project authenticated IPA or macOS app inventory Evidence into Apple application evidence. */
export const projectAppleApplicationEvidence = (
  rawInput: unknown,
): Result<Evidence, AnalysisError> => {
  return projectInventoryEvidence({
    rawInput,
    schema: appleApplicationProjectionInputSchema,
    project: projectAppleApplication,
    operation: OPERATION,
    predicateType: "rea.apple-application-graph",
    provider: APPLE_APPLICATION_PROVIDER,
    subjectFormat: (first) => first.subject?.format ?? "unknown",
    protocolError: "Apple application projection produced an invalid result",
  });
};
