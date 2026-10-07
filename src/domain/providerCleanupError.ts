import type { JsonValue } from "./jsonValue.js";
import { ProviderAdapterError } from "./providerAdapterError.js";

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
    options?: ErrorOptions & { readonly operation?: string },
  ) {
    const { operation = "close_binary", ...errorOptions } = options ?? {};
    super(providerId, operation, { ...errorOptions, diagnostics });
    this.cleanupResources = [...resources];
  }
}
