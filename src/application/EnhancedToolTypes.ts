import type { z } from "zod";

import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { LiteralFeatureReference } from "../domain/native/literalFeatureTrace.js";
import { err, type Result } from "../domain/result.js";
import {
  enhancedInputSchemas,
  type EnhancedToolName,
} from "../contracts/enhancedInputs.js";

/** A failure that stopped a workflow after it admitted part of its result. */
export interface PartialEnhancedFailure {
  readonly ok: false;
  readonly error: AnalysisError;
  /** The workflow's own result shape, holding only work admitted before the stop. */
  readonly partialResult: JsonValue;
}
export type EnhancedOutcome =
  | Result<JsonValue, AnalysisError>
  | PartialEnhancedFailure;
export type EnhancedResult = Promise<EnhancedOutcome>;

/** Keep the stopping failure primary while retaining the admitted result. */
export const failedWithPartialResult = (
  error: AnalysisError,
  partialResult: JsonValue,
): PartialEnhancedFailure => ({ ok: false, error, partialResult });
export type TraceReference = LiteralFeatureReference;

/** One enhanced call whose input was parsed at its owning adapter boundary. */
export type ValidatedEnhancedCall = {
  [Name in EnhancedToolName]: {
    readonly name: Name;
    readonly input: z.output<(typeof enhancedInputSchemas)[Name]>;
  };
}[EnhancedToolName];

export const invalidEnhancedInput = (
  name: EnhancedToolName,
  cause: z.ZodError,
  input: unknown,
): EnhancedResult =>
  Promise.resolve(
    err(analysisInputErrorFromIssues(name, cause.issues, input, { cause })),
  );
