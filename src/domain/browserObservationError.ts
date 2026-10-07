import type {
  BrowserObservationFailureReason,
  BrowserObservationOperation,
} from "./browserObservationErrors.js";
import { AnalysisError } from "./analysisErrorBase.js";
import { AnalysisCancelledError } from "./analysisErrorCore.js";

/** A bounded passive browser observation failed at its CDP boundary. */
export class BrowserObservationError extends AnalysisError {
  readonly _tag = "BrowserObservationError";
  override readonly cleanupIncomplete: boolean;
  override readonly cleanupResources: readonly string[];
  override readonly userCategory: "cancelled" | undefined;
  override readonly userMessage: string | undefined;

  constructor(
    readonly operation: BrowserObservationOperation,
    readonly reason: BrowserObservationFailureReason,
    options?: ErrorOptions & { readonly detail?: string },
  ) {
    super(`Browser observation ${operation} failed: ${reason}`, options);
    this.userMessage = options?.detail;
    this.cleanupIncomplete = reason === "cleanup_failed";
    this.cleanupResources =
      reason === "cleanup_failed" ? ["browser_transport"] : [];
    this.userCategory =
      reason === "cancelled" || options?.cause instanceof AnalysisCancelledError
        ? "cancelled"
        : undefined;
  }
}
