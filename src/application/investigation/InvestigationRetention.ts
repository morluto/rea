import { getHeapStatistics } from "node:v8";

import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisResourceConstraintError } from "../../domain/analysisErrorCore.js";
import { EvidenceIntegrityError } from "../../domain/evidenceErrors.js";
import { jsonValueValidationIssue } from "../../domain/jsonValue.js";
import { err, ok, type Result } from "../../domain/result.js";
import {
  estimateJsonStorage,
  requireAuthenticationHeadroom,
} from "../JsonAuthenticationHeadroom.js";

/** Instance policy; the live authentication allowance is never retained state. */
export interface InvestigationRetentionPolicy {
  readonly maximumRepresentationBytes?: number;
  readonly availableAuthenticationBytes?: () => number;
}

/** Owner admission used before materializing a completed recovery record. */
export type RecoveryAdmission = (
  input: unknown,
  operation: string,
  additional: {
    readonly valueBytes: number;
    readonly serializedUtf16Bytes: number;
  },
) => Result<void, AnalysisError>;

/**
 * Reserve one retained representation, two authentication/canonical working
 * copies and one detached export/control representation from current V8 room.
 * This is conservative representation accounting, not a process RSS guarantee.
 */
export const investigationMaximumRepresentationBytes = (
  policy: InvestigationRetentionPolicy,
): number => {
  const maximum =
    policy.maximumRepresentationBytes ??
    Math.floor(getHeapStatistics().total_available_size / 4);
  if (!Number.isSafeInteger(maximum) || maximum < 0)
    throw new RangeError(
      "Investigation representation allowance must be a nonnegative safe integer",
    );
  return maximum;
};

/** Validate borrowed JSON before the authentication estimator accesses it. */
export const admitInvestigationAuthentication = (
  input: unknown,
  operation: string,
  policy: InvestigationRetentionPolicy,
  additional?: {
    readonly valueBytes: number;
    readonly serializedUtf16Bytes: number;
  },
): Result<void, AnalysisError> => {
  const issue = jsonValueValidationIssue(input);
  if (issue !== undefined)
    return err(
      new EvidenceIntegrityError("Investigation input is not ordinary JSON", {
        userMessage: issue,
      }),
    );
  return requireAuthenticationHeadroom(input, {
    operation,
    path: "investigation",
    description:
      "Insufficient live heap headroom to authenticate investigation records",
    ...(additional === undefined ? {} : { additional }),
    ...(policy.availableAuthenticationBytes === undefined
      ? {}
      : { availableBytes: policy.availableAuthenticationBytes() }),
  });
};

/** Exact for admitted data; above the budget it establishes only a lower bound. */
export const investigationValueBytes = (
  input: unknown,
  remainingBytes: number,
): number =>
  estimateJsonStorage(input, {
    maximumValueBytes: Math.max(0, remainingBytes),
    includeSerialized: false,
  }).valueBytes;

export const admitInvestigationRetention = (
  operation: string,
  retainedBytes: number,
  deltaBytes: number,
  maximumBytes: number,
): Result<void, AnalysisError> =>
  retainedBytes + deltaBytes <= maximumBytes
    ? ok(undefined)
    : err(
        new AnalysisResourceConstraintError(
          operation,
          "capacity",
          "The investigation's retained representation allowance is exhausted.",
          {
            retained_representation_bytes: retainedBytes,
            requested_delta_bytes: deltaBytes,
            maximum_representation_bytes: maximumBytes,
          },
          {
            remediationAction:
              "Export the retained investigation and start a new investigation, or increase the parent Node process heap before starting it. Retention never evicts existing Evidence or Unknown history.",
          },
        ),
      );
