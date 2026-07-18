import type { z } from "zod";

import { AnalysisInputError, type AnalysisError } from "../domain/errors.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { err, type Result } from "../domain/result.js";
import {
  enhancedInputSchemas,
  type EnhancedToolName,
} from "../contracts/enhancedInputs.js";

export type EnhancedResult = Promise<Result<JsonValue, AnalysisError>>;
export type TraceMatch = {
  readonly type: string;
  readonly address: string;
  readonly value: string;
};
export type TraceReference = {
  readonly target_address: string;
  readonly source_address: string;
  readonly containing_procedure: JsonValue;
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
