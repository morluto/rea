import {
  ProviderAdapterError,
  type ProviderAdapterErrorOptions,
} from "./providerAdapterError.js";

/**
 * What the shared outcome classifier examined for one owned command whose
 * exit or stream failure the provider's dialect did not recognise. Field names are the reported diagnostic keys.
 */
export interface ExaminedProviderOutcome {
  /** The physical outcome kind the supervisor observed. */
  readonly failure_kind: "exited" | "protocol";
  readonly reason: string;
  /** Null when the process did not exit with a status. */
  readonly exit_code: number | null;
  readonly signal: string | null;
  /** For an exit: whether the owner had begun stopping the process. */
  readonly stop_requested?: boolean;
  /** Whether the retained output omits bytes; absent when none was retained. */
  readonly output_truncated?: boolean;
}

/**
 * An owned provider command's outcome that its dialect examined and did not
 * recognise. It reports as the generic provider adapter failure and always
 * carries the examined outcome, so the fallback states what was checked.
 * Only `classifyProviderOutcome` constructs it, from the outcome it examined.
 */
export class UnclassifiedProviderFailure extends ProviderAdapterError {
  constructor(
    providerId: string,
    operation: string,
    readonly examined: ExaminedProviderOutcome,
    /** `diagnostics` are provider facts reported beside the examined outcome. */
    options: ProviderAdapterErrorOptions = {},
  ) {
    super(providerId, operation, {
      ...options,
      diagnostics: { ...options.diagnostics, ...examined },
    });
  }
}
