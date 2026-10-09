import type { JsonValue } from "./jsonValue.js";
import { ProviderAdapterError } from "./providerAdapterError.js";
import type { AnalysisPartialObservation } from "./analysisErrorBase.js";

/** Provider resources could not be proven closed after bounded cleanup. */
export class ProviderCleanupError extends ProviderAdapterError {
  override readonly cleanupIncomplete = true;
  override readonly cleanupResources: readonly string[];
  override readonly userMessage =
    "Provider cleanup could not be fully confirmed. Review the reported local resources before opening another target.";

  constructor(
    providerId: string,
    resources: readonly string[],
    diagnostics: Readonly<Record<string, JsonValue>>,
    /** Identify the operation owning these resources; binary callers retain their default. */
    options?: ErrorOptions & {
      readonly operation?: string;
      readonly partialObservation?: AnalysisPartialObservation;
    },
  ) {
    const {
      operation = "close_binary",
      partialObservation,
      ...errorOptions
    } = options ?? {};
    super(providerId, operation, {
      ...errorOptions,
      ...(partialObservation === undefined ? {} : { partialObservation }),
      diagnostics,
    });
    this.cleanupResources = [...resources];
  }
}
