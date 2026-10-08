import type { JsonValue } from "./jsonValue.js";
import {
  AnalysisError,
  type AnalysisErrorOptions,
} from "./analysisErrorBase.js";

/** A provider adapter failed outside its more precise typed variants. */
export interface ProviderAdapterErrorOptions extends AnalysisErrorOptions {
  readonly diagnostics?: Readonly<Record<string, JsonValue>>;
}

/** A provider adapter failed outside its more precise typed variants. */
export class ProviderAdapterError extends AnalysisError {
  readonly _tag = "ProviderAdapterError";
  readonly diagnostics: Readonly<Record<string, JsonValue>> | undefined;

  constructor(
    readonly providerId: string,
    readonly operation: string,
    options: ProviderAdapterErrorOptions = {},
  ) {
    super(`Provider ${providerId} adapter failed during ${operation}`, options);
    this.diagnostics =
      options.diagnostics === undefined
        ? undefined
        : structuredClone(options.diagnostics);
  }
}
