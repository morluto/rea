import { z } from "zod";
import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import type { AnalysisViewRequest } from "../domain/analysisView/analysisViewRequest.js";
import { localPathStringSchema } from "../domain/localPath.js";

export const analysisEvidenceDeliveryOptions = {
  detail: z
    .enum(["complete", "summary"])
    .optional()
    .describe(
      "Omit for complete Evidence when it fits the agent result budget (32768 compact JSON bytes by default, about 11k tokens) and its summary otherwise; complete always delivers everything; summary needs --evidence_output",
    ),
  evidence_output: localPathStringSchema
    .optional()
    .describe(
      "Save complete Evidence as a bundle; required for summary delivery. Never overwrites.",
    ),
};

/**
 * The caller's `--detail`; undefined leaves delivery to the agent result
 * budget: complete Evidence when it fits, its summary otherwise.
 */
export type CliDeliveryDetail = "complete" | "summary" | undefined;

/**
 * Refuse a delivery that cannot keep complete source Evidence available: a
 * summary needs a bundle, and a selected page is cut from a retained summary.
 */
export const cliEvidenceDeliveryInputError = (input: {
  readonly detail: CliDeliveryDetail;
  readonly evidenceOutput: string | undefined;
  readonly operation: string;
  readonly view?: AnalysisViewRequest | undefined;
}): AnalysisInputError | undefined => {
  if (input.view !== undefined && input.detail !== "summary")
    return new AnalysisInputError(input.operation, undefined, [
      {
        path: ["view"],
        reason: "invalid_value",
        message:
          "A selected page requires --detail summary and --evidence_output.",
      },
    ]);
  return input.detail === "summary" && input.evidenceOutput === undefined
    ? new AnalysisInputError(input.operation, undefined, [
        {
          path: ["evidence_output"],
          reason: "invalid_value",
          message:
            "Summary delivery requires --evidence_output so complete source Evidence remains available.",
        },
      ])
    : undefined;
};
