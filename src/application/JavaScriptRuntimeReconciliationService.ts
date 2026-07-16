import { z } from "zod";

import {
  AnalysisInputError,
  AnalysisProtocolError,
  type AnalysisError,
} from "../domain/errors.js";
import type { Evidence } from "../domain/evidence.js";
import { projectInputIssues } from "../domain/inputIssueProjection.js";
import { reconcileJavaScriptRuntime } from "../domain/javascriptRuntimeReconciliation.js";
import { reconcileJavaScriptRuntimeInputSchema } from "../domain/javascriptRuntimeReconciliationSchemas.js";
import { err, ok, type Result } from "../domain/result.js";
import { createJavaScriptRuntimeReconciliationEvidence } from "./JavaScriptRuntimeReconciliationEvidence.js";

const OPERATION = "reconcile_javascript_runtime" as const;

/** Derive a combined JAG from verified static and passive-runtime Evidence. */
export const reconcileJavaScriptRuntimeEvidence = (
  rawInput: unknown,
): Result<Evidence, AnalysisError> => {
  const parsed = reconcileJavaScriptRuntimeInputSchema.safeParse(rawInput);
  if (!parsed.success)
    return err(
      new AnalysisInputError(
        OPERATION,
        undefined,
        projectInputIssues(parsed.error.issues, rawInput),
      ),
    );
  return reconcileJavaScriptRuntimeEvidenceValidated(parsed.data);
};

/** Reconcile input already parsed by a trusted adapter boundary. */
export const reconcileJavaScriptRuntimeEvidenceValidated = (
  input: z.output<typeof reconcileJavaScriptRuntimeInputSchema>,
): Result<Evidence, AnalysisError> => {
  try {
    const result = reconcileJavaScriptRuntime(input);
    return ok(createJavaScriptRuntimeReconciliationEvidence(input, result));
  } catch (cause: unknown) {
    return err(
      cause instanceof z.ZodError || cause instanceof TypeError
        ? new AnalysisInputError(OPERATION)
        : new AnalysisProtocolError(
            "JavaScript runtime reconciliation produced an invalid result",
            { cause },
          ),
    );
  }
};
