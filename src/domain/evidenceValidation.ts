import { z } from "zod";

import { parseEvidence, immutableEvidence, type Evidence } from "./evidence.js";
import { EvidenceIntegrityError } from "./evidenceErrors.js";
import {
  isUnsupportedEvidenceFormat,
  type UnsupportedEvidenceFormat,
} from "./evidenceFormat.js";
import {
  describeValidationFailure,
  firstValidationIssue,
} from "./validationFailure.js";
import { err, ok, type Result } from "./result.js";

/** A record that fails its schema, or one written in another format revision. */
export type EvidenceReadFailure = z.ZodError | UnsupportedEvidenceFormat;

/** Expected authentication failures, independent of a caller's error contract. */
export const safeParseEvidence = (
  input: unknown,
): Result<Evidence, EvidenceReadFailure> =>
  authenticateEvidence(input, parseEvidence);

/** Authenticate and seal source records while retaining typed validation failures. */
export const safeParseImmutableEvidence = (
  input: unknown,
): Result<Evidence, EvidenceReadFailure> =>
  authenticateEvidence(input, immutableEvidence);

/**
 * Recognize Evidence in a union of partial observations. Input that names no
 * `evidence_id` is not an Evidence record. A record that names one but fails
 * authentication, or was written in another format revision, is a refusal,
 * never absent: callers must not read it as "no Evidence".
 */
export const recognizeEvidence = (
  input: unknown,
): Result<Evidence | undefined, EvidenceIntegrityError> =>
  typeof input === "object" && input !== null && "evidence_id" in input
    ? readEvidence(input)
    : ok(undefined);

/**
 * The single refusal of Evidence from another format revision: an integrity
 * mismatch whose message carries the recreate guidance, as for bundles.
 */
export const unsupportedEvidenceFormatError = (
  cause: UnsupportedEvidenceFormat,
  side?: "left" | "right",
): EvidenceIntegrityError =>
  new EvidenceIntegrityError(cause.message, {
    cause,
    userMessage: cause.message,
    ...(side === undefined ? {} : { side }),
  });

/**
 * Where a source record sits in a two-sided request, and where a validated
 * payload sits inside its Evidence record, so failures name both.
 */
export interface EvidenceSourceLocation {
  readonly side?: "left" | "right";
  /** Path of a validated payload inside the Evidence record. */
  readonly within?: readonly (string | number)[];
}

/** Authenticate one source record, preserving unexpected implementation failures. */
export const readEvidence = (
  input: unknown,
  location?: Pick<EvidenceSourceLocation, "side">,
): Result<Evidence, EvidenceIntegrityError> => {
  const parsed = safeParseEvidence(input);
  return parsed.ok
    ? parsed
    : err(integrityFailure(parsed.error, { ...location, within: [] }));
};

/** Authenticate and seal source records retained independently of mutable input. */
export const readImmutableEvidence = (
  input: unknown,
): Result<Evidence, EvidenceIntegrityError> => {
  const parsed = safeParseImmutableEvidence(input);
  return parsed.ok
    ? parsed
    : err(integrityFailure(parsed.error, { within: [] }));
};

const authenticateEvidence = (
  input: unknown,
  parse: (input: unknown) => Evidence,
): Result<Evidence, EvidenceReadFailure> => {
  try {
    return ok(parse(input));
  } catch (cause: unknown) {
    if (cause instanceof z.ZodError || isUnsupportedEvidenceFormat(cause))
      return err(cause);
    throw cause;
  }
};

/** Validate an authenticated source payload, separately from generated output. */
export const readEvidencePayload = <Output>(
  schema: z.ZodType<Output>,
  input: unknown,
  location?: EvidenceSourceLocation,
): Result<Output, EvidenceIntegrityError> => {
  const parsed = schema.safeParse(input);
  return parsed.success
    ? ok(parsed.data)
    : err(integrityFailure(parsed.error, location));
};

/**
 * Schema issue facts for an integrity failure. The issue path is reported
 * only when its position in the record (`within`) is known.
 */
export const validationIssueOptions = (
  cause: unknown,
  within?: readonly (string | number)[],
): {
  readonly issuePath?: readonly (string | number)[];
  readonly constraint?: string;
  readonly remainingIssueCount?: number;
} => {
  const issue = firstValidationIssue(cause);
  if (issue === undefined) return {};
  return {
    ...(within === undefined ? {} : { issuePath: [...within, ...issue.path] }),
    ...(issue.constraint === undefined ? {} : { constraint: issue.constraint }),
    remainingIssueCount: issue.remainingIssueCount,
  };
};

const integrityFailure = (
  cause: EvidenceReadFailure,
  location: EvidenceSourceLocation | undefined,
): EvidenceIntegrityError => {
  if (isUnsupportedEvidenceFormat(cause))
    return unsupportedEvidenceFormatError(cause, location?.side);
  const message = `Evidence validation failed ${describeValidationFailure(cause)}`;
  return new EvidenceIntegrityError(message, {
    cause,
    userMessage: message,
    ...(location?.side === undefined ? {} : { side: location.side }),
    ...validationIssueOptions(cause, location?.within),
  });
};
