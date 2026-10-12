import {
  AnalysisError,
  type AnalysisErrorOptions,
} from "./analysisErrorBase.js";

/** Receipt retained when publication succeeded but staging cleanup did not. */
export interface PublishedEvidenceFile {
  readonly path: string;
  readonly bytes: number;
}

/** Evidence identity, schema, or bundle manifests failed integrity checks. */
export class EvidenceIntegrityError extends AnalysisError {
  readonly _tag = "EvidenceIntegrityError";
  override readonly userMessage: string | undefined;

  constructor(
    message: string,
    options?: AnalysisErrorOptions & { readonly userMessage?: string },
  ) {
    super(message, options);
    this.userMessage = options?.userMessage;
  }
}

/** A valid snapshot belongs to a different target, provider, or analysis profile. */
export class AnalysisSnapshotMismatchError extends EvidenceIntegrityError {}

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
  override readonly userMessage: string | undefined;

  /** Caller-selected path that failed, resolved against the working directory. */
  readonly path: string | undefined;
  /** Present only when a write committed before cleanup failed. */
  readonly published: PublishedEvidenceFile | undefined;

  constructor(
    readonly operation: "read" | "write",
    readonly reason:
      | "not-file"
      | "exists"
      | "wrong-kind"
      | "invalid-json"
      | "missing"
      | "io",
    options?: AnalysisErrorOptions & {
      readonly path?: string;
      readonly published?: PublishedEvidenceFile;
      readonly userMessage?: string;
    },
  ) {
    super(`Evidence bundle ${operation} failed: ${reason}`, options);
    this.path = options?.path;
    this.published = options?.published;
    this.userMessage = options?.userMessage;
  }
}
