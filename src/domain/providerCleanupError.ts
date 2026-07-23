import { ProviderAdapterError } from "./errors.js";
import type { JsonValue } from "./jsonValue.js";

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
    options?: ErrorOptions,
  ) {
    super(providerId, "close_binary", { ...options, diagnostics });
    this.cleanupResources = [...resources];
  }
}
