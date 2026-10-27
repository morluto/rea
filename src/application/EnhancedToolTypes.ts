import type { z } from "zod";

import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { ContainingProcedureResolution } from "../domain/native/nativeObservation.js";
import { err, type Result } from "../domain/result.js";
import {
  enhancedInputSchemas,
  type EnhancedToolName,
} from "../contracts/enhancedInputs.js";

export type EnhancedResult = Promise<Result<JsonValue, AnalysisError>>;
export type TraceReference = {
  readonly target_address: string;
  readonly source_address: string;
  readonly containing_procedure: ContainingProcedureResolution;
};

/** One enhanced call whose input was parsed at its owning adapter boundary. */
export type ValidatedEnhancedCall = {
  [Name in EnhancedToolName]: {
    readonly name: Name;
    readonly input: z.output<(typeof enhancedInputSchemas)[Name]>;
  };
}[EnhancedToolName];

export const invalidEnhancedInput = (
  name: EnhancedToolName,
  cause: Error,
): EnhancedResult =>
  Promise.resolve(err(new AnalysisInputError(name, { cause })));
