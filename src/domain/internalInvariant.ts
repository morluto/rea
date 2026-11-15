/**
 * A broken internal assumption: code reached a state its own earlier checks
 * rule out, such as a plan its preflight should have produced. This is a REA
 * defect, never evidence about the input, so parsers throw it instead of a
 * `ParseFailureError`, and no ParseFailure kind (malformed,
 * truncated, unsupported or limit) describes it.
 */
export class InternalInvariantError extends Error {
  readonly _tag = "InternalInvariantError";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InternalInvariantError";
  }
}

/** Report a broken internal assumption; `throw invariantViolation(...)`. */
export const invariantViolation = (
  message: string,
  options?: ErrorOptions,
): InternalInvariantError => new InternalInvariantError(message, options);
