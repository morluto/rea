import { AnalysisError } from "./analysisErrorBase.js";

/** Residual-unknown mutation failed a lifecycle, reference, or CAS invariant. */
export class UnknownRegistryError extends AnalysisError {
  readonly _tag = "UnknownRegistryError";

  constructor(
    readonly reason:
      | "not-found"
      | "already-exists"
      | "revision-conflict"
      | "invalid-transition"
      | "integrity"
      | "limit",
    options?: ErrorOptions,
  ) {
    super(`Residual unknown registry mutation failed: ${reason}`, options);
  }
}
