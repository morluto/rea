import type { EvidenceLookup } from "../EvidenceInputResolver.js";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  appleApplicationProjectionInputSchema,
  projectAppleInventory,
} from "../../domain/apple/appleApplication.js";
import type { Result } from "../../domain/result.js";
import { APPLE_APPLICATION_PROVIDER } from "../../domain/investigationProviders.js";
import {
  projectInventoryEvidence,
  type InventoryProjectionEvidenceResult,
} from "../InventoryProjectionEvidence.js";

const OPERATION = "project_apple_application_graph" as const;

/** Project authenticated IPA or macOS app inventory Evidence into Apple application evidence. */
export const projectAppleApplicationEvidence = (
  rawInput: unknown,
  lookup?: EvidenceLookup,
  execution?: Pick<ExecutionOptions, "signal">,
): Result<InventoryProjectionEvidenceResult, AnalysisError> => {
  return projectInventoryEvidence({
    rawInput,
    inputSchema: appleApplicationProjectionInputSchema,
    ...(lookup === undefined ? {} : { lookup }),
    ...(execution === undefined ? {} : { execution }),
    project: (inventory, { include_bundle_placement }) =>
      projectAppleInventory(inventory, include_bundle_placement),
    inputParameters: ({ include_bundle_placement }) =>
      include_bundle_placement === undefined
        ? {}
        : { include_bundle_placement },
    operation: OPERATION,
    predicateType: "rea.apple-application-graph",
    provider: APPLE_APPLICATION_PROVIDER,
  });
};
