import { AnalysisError } from "./analysisErrorBase.js";

/** Evidence identity, schema, or bundle manifests failed integrity checks. */
export class EvidenceIntegrityError extends AnalysisError {
  readonly _tag = "EvidenceIntegrityError";
}

/** A session Evidence reference is missing or has the wrong semantic identity. */
export class EvidenceReferenceError extends EvidenceIntegrityError {
  constructor(
    readonly evidenceId: string,
    readonly reason:
      | "missing"
      | "wrong_operation"
      | "wrong_predicate"
      | "identity_mismatch",
    readonly expected: string,
    readonly actual: string | null,
  ) {
    super(`Evidence reference ${reason}: ${evidenceId}`);
  }
}

/** Evidence bundle filesystem access failed within the configured policy. */
export class EvidenceFileError extends AnalysisError {
  readonly _tag = "EvidenceFileError";

  constructor(
    readonly operation: "read" | "write",
    readonly reason: "not-file" | "exists" | "invalid-json" | "io",
    options?: ErrorOptions,
  ) {
    super(`Evidence bundle ${operation} failed: ${reason}`, options);
  }
}
