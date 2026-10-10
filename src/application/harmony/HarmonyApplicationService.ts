import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { Evidence } from "../../domain/evidence.js";
import {
  harmonyApplicationProjectionInputSchema,
  projectHarmonyApplication,
} from "../../domain/harmony/harmonyApplication.js";
import type { Result } from "../../domain/result.js";
import { HARMONY_APPLICATION_PROVIDER } from "../InvestigationProviders.js";
import { projectInventoryEvidence } from "../InventoryProjectionEvidence.js";

const OPERATION = "project_harmony_application_graph" as const;

/** Project authenticated HarmonyOS package inventory Evidence into application evidence. */
export const projectHarmonyApplicationEvidence = (
  rawInput: unknown,
): Result<Evidence, AnalysisError> => {
  return projectInventoryEvidence({
    rawInput,
    schema: harmonyApplicationProjectionInputSchema,
    project: projectHarmonyApplication,
    operation: OPERATION,
    predicateType: "rea.harmony-application-graph",
    provider: HARMONY_APPLICATION_PROVIDER,
    subjectFormat: (first) => first.subject?.format ?? "unknown",
    protocolError:
      "HarmonyOS application projection produced an invalid result",
  });
};
